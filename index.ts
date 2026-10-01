/**
 * Session Importer Extension for Pi / Piwin.
 * Imports transcripts from Claude Code, Cursor, Codex, and OpenCode.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type ForeignHarness = 'claude' | 'cursor' | 'codex' | 'opencode';

export type ForeignTurn = {
  role: 'user' | 'assistant';
  text: string;
};

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /sk-[A-Za-z0-9]{8,}/gi,
  /(?:api[_-]?key|password|token)\s*[:=]\s*\S+/gi,
];

const WRAPPERS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<task-notification>[\s\S]*?<\/task-notification>/gi,
  /<turn_aborted>[\s\S]*?<\/turn_aborted>/gi,
  /<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi,
  /\[Request interrupted by user[^\]]*\]/gi,
];

function sanitizeText(raw: string): string {
  let cleaned = raw;
  for (const pattern of WRAPPERS) {
    cleaned = cleaned.replace(pattern, '');
  }
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[REDACTED_SECRET]');
  }
  return cleaned.trim();
}

function parseJsonOrJsonl(content: string): Record<string, unknown>[] {
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
      }
    } catch {
      // Fall through to line-by-line
    }
  }
  const records: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const item = JSON.parse(l);
      if (typeof item === 'object' && item !== null) {
        records.push(item);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

export function parseTranscript(harness: ForeignHarness, rawContent: string): ForeignTurn[] {
  const records = parseJsonOrJsonl(rawContent);
  const turns: ForeignTurn[] = [];

  for (const record of records) {
    let role: 'user' | 'assistant' | null = null;
    let text = '';

    if (harness === 'codex') {
      const payload = (typeof record.payload === 'object' && record.payload !== null ? record.payload : record) as Record<string, unknown>;
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        role = 'user';
        text = payload.message;
      } else {
        const rawRole = payload.role ?? record.role;
        if (rawRole === 'user' || rawRole === 'assistant') role = rawRole as 'user' | 'assistant';
        text = extractText(payload.content ?? payload.message ?? payload.text);
      }
    } else {
      const rawRole = record.role ?? (typeof record.message === 'object' && record.message !== null ? (record.message as Record<string, unknown>).role : null);
      if (rawRole === 'user' || rawRole === 'assistant') role = rawRole as 'user' | 'assistant';
      text = extractText(record.content ?? record.message ?? record.text);
    }

    if (role && text) {
      const sanitized = sanitizeText(text);
      if (sanitized) {
        const last = turns[turns.length - 1];
        if (last && last.role === role) {
          last.text += '\n\n' + sanitized;
        } else {
          turns.push({ role, text: sanitized });
        }
      }
    }
  }
  return turns;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          const rec = item as Record<string, unknown>;
          if (typeof rec.text === 'string') return rec.text;
          if (rec.type === 'tool_use' || rec.type === 'tool_call') {
            return '[工具调用: ' + (rec.name ?? 'tool') + ']';
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === 'string') return rec.text;
    if (typeof rec.content === 'string') return rec.content;
  }
  return '';
}

function findLocalSessionFiles(harness: ForeignHarness): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  try {
    if (harness === 'claude') {
      const claudeDir = path.join(home, '.claude', 'projects');
      if (fs.existsSync(claudeDir)) {
        for (const proj of fs.readdirSync(claudeDir)) {
          const projDir = path.join(claudeDir, proj);
          if (fs.statSync(projDir).isDirectory()) {
            for (const file of fs.readdirSync(projDir)) {
              if (file.endsWith('.jsonl') || file.endsWith('.json')) {
                candidates.push(path.join(projDir, file));
              }
            }
          }
        }
      }
    } else if (harness === 'codex') {
      const codexDir = path.join(home, '.codex', 'sessions');
      if (fs.existsSync(codexDir)) {
        for (const file of fs.readdirSync(codexDir)) {
          if (file.endsWith('.jsonl') || file.endsWith('.json')) {
            candidates.push(path.join(codexDir, file));
          }
        }
      }
    }
  } catch {
    // Ignore access errors
  }
  return candidates.slice(0, 10);
}

export default function (pi: {
  registerCommand: (name: string, def: unknown) => void;
  registerTool?: (def: unknown) => void;
}) {
  pi.registerCommand('import-session', {
    description: '导入 Claude Code、Cursor、Codex 等外部会话记录',
    handler: async (_args: string, ctx: {
      ui: {
        select: (msg: string, opts: string[]) => Promise<string | undefined>;
        input: (msg: string, placeholder?: string) => Promise<string | undefined>;
        notify: (msg: string, level?: 'info' | 'warning' | 'error') => void;
        setStatus?: (key: string, text: string | undefined) => void;
        setWidget?: (key: string, lines: string[] | undefined) => void;
      };
      prompt?: (text: string) => Promise<unknown>;
    }) => {
      const platforms: { label: string; harness: ForeignHarness }[] = [
        { label: 'Claude Code (~/.claude)', harness: 'claude' },
        { label: 'Cursor (~/.cursor)', harness: 'cursor' },
        { label: 'Codex (~/.codex)', harness: 'codex' },
        { label: 'OpenCode / 自定义文件', harness: 'opencode' },
      ];

      const selectedPlatform = await ctx.ui.select(
        '请选择会话来源平台：',
        platforms.map((p) => p.label),
      );
      if (!selectedPlatform) return;

      const matched = platforms.find((p) => p.label === selectedPlatform);
      const harness = matched?.harness ?? 'claude';

      let filePath: string | undefined;
      const localFiles = findLocalSessionFiles(harness);

      if (localFiles.length > 0) {
        const fileChoice = await ctx.ui.select('检测到本地历史会话，请选择或手动输入：', [
          ...localFiles.map((f) => path.basename(f) + ' (' + path.dirname(f) + ')'),
          '📂 手动输入文件路径...',
        ]);
        if (!fileChoice) return;
        if (fileChoice.startsWith('📂')) {
          filePath = await ctx.ui.input('请输入会话文件绝对路径 (.json / .jsonl)：');
        } else {
          const idx = localFiles.findIndex((f) => fileChoice.startsWith(path.basename(f)));
          filePath = localFiles[idx >= 0 ? idx : 0];
        }
      } else {
        filePath = await ctx.ui.input('请输入会话记录文件绝对路径 (.json / .jsonl)：', '如: ~/.claude/projects/my-session.jsonl');
      }

      if (!filePath || !filePath.trim()) {
        ctx.ui.notify('已取消导入', 'info');
        return;
      }

      const resolvedPath = path.resolve(filePath.trim().replace(/^~/, os.homedir()));
      if (!fs.existsSync(resolvedPath)) {
        ctx.ui.notify('未找到指定文件：' + resolvedPath, 'error');
        return;
      }

      try {
        const content = fs.readFileSync(resolvedPath, 'utf8');
        const turns = parseTranscript(harness, content);

        if (turns.length === 0) {
          ctx.ui.notify('未能从该文件中解析出有效会话对话。', 'warning');
          return;
        }

        const countChoice = await ctx.ui.select(
          `已解析 ${turns.length} 轮对话，请选择导入轮次：`,
          [
            `全部导入 (${turns.length} 轮)`,
            `最近 30 轮 (${Math.min(30, turns.length)} 轮)`,
            `最近 10 轮 (${Math.min(10, turns.length)} 轮)`,
          ],
        );
        if (!countChoice) return;

        let selectedTurns = turns;
        if (countChoice.includes('10')) selectedTurns = turns.slice(-10);
        else if (countChoice.includes('30')) selectedTurns = turns.slice(-30);

        ctx.ui.setWidget?.('session-import', [
          `📦 已导入外部会话: ${path.basename(resolvedPath)}`,
          `来源: ${harness} | 导入轮数: ${selectedTurns.length}/${turns.length} 轮`,
        ]);
        ctx.ui.setStatus?.('session-import', `会话已导入 (${selectedTurns.length}轮)`);
        ctx.ui.notify(`成功导入 ${selectedTurns.length} 轮外部会话！`, 'info');

        if (ctx.prompt) {
          const header = `【已从 ${harness} 导入历史会话（共 ${selectedTurns.length} 轮）】：\n\n`;
          const body = selectedTurns.map((t) => `[${t.role === 'user' ? '用户' : '助手'}]:\n${t.text}`).join('\n\n---\n\n');
          await ctx.prompt(header + body + '\n\n请结合以上历史上下文继续推进后续任务。');
        }
      } catch (err) {
        ctx.ui.notify('导入处理失败: ' + String(err), 'error');
      }
    },
  });

  if (typeof pi.registerTool === 'function') {
    pi.registerTool({
      name: 'import_foreign_session',
      description: '从外部 coding agent (Claude Code / Cursor / Codex) 解析导入会话历史',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '历史会话文件路径' },
          harness: { type: 'string', enum: ['claude', 'cursor', 'codex', 'opencode'], description: '来源工具' },
        },
        required: ['filePath', 'harness'],
      },
      handler: async (args: { filePath: string; harness: ForeignHarness }) => {
        const resolved = path.resolve(args.filePath.replace(/^~/, os.homedir()));
        if (!fs.existsSync(resolved)) {
          return { error: '文件不存在: ' + resolved };
        }
        const turns = parseTranscript(args.harness, fs.readFileSync(resolved, 'utf8'));
        return {
          harness: args.harness,
          totalTurns: turns.length,
          sampleTurns: turns.slice(-5),
        };
      },
    });
  }
}

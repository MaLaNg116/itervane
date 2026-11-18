import { z } from 'zod';

export const localeSchema = z.enum(['en', 'zh-CN']);
export type Locale = z.infer<typeof localeSchema>;
export const en = {
  'error.invalid_input': 'The request is invalid.', 'error.unauthenticated': 'Sign in with a valid access token.',
  'error.forbidden': 'You do not have permission for this action.', 'error.not_found': 'The resource was not found.',
  'error.conflict': 'The request conflicts with existing data.', 'error.idempotency_conflict': 'This request key was already used with different input.',
  'error.version_conflict': 'The task changed. Refresh it before trying again.', 'error.unsupported_state': 'This action is unavailable in the current state.',
  'error.unavailable': 'A required service is unavailable.', 'error.internal_error': 'The server could not complete the request.',
  'error.resume_limit': 'The task has reached its resume limit.',
  'task.accepted': 'Task accepted and queued.', 'task.cancelled': 'Task cancelled.', 'task.started': 'Task preflight started.',
  'task.recovered': 'An interrupted execution was queued for recovery.', 'task.paused': 'Task is waiting for a verified Runner.',
  'task.resumed': 'Task queued to retry its preflight.', 'task.cancel_requested': 'Cancellation requested; the execution is stopping.',
  'task.needs_human': 'Task stopped and requires human attention.', 'task.waiting_child': 'Task is waiting for a linked task.',
  'task.tool_observed': 'A controlled tool observation was recorded.', 'task.updated': 'Task updated.',
  'tool.project_describe': 'Read registered project and source metadata.', 'tool.source_inspect': 'Inspect the fixed source only through a verified isolated Runner.',
  'tool.runner_unavailable': 'Source inspection is blocked until a verified isolated Runner is available.',
  'mcp.start': 'Queue an audit of a registered fixed Git revision. This does not approve or deploy it.',
  'mcp.query': 'Read the current authorized task state.', 'mcp.events': 'Read authorized task events.',
  'mcp.cancel': 'Request task cancellation using its current version.', 'mcp.resume': 'Retry a paused preflight. This does not grant approval.',
  'mcp.result': 'The task request was processed. Use its task ID to query progress.',
  'state.queued': 'Queued', 'state.running': 'Running', 'state.waiting_approval': 'Waiting for approval',
  'state.waiting_input': 'Waiting for input', 'state.reconciling': 'Reconciling', 'state.succeeded': 'Succeeded',
  'state.failed': 'Failed', 'state.cancel_requested': 'Cancellation requested', 'state.cancelled': 'Cancelled', 'state.needs_human': 'Needs human attention',
} as const;
export type MessageKey = keyof typeof en;
export const zhCN: Record<MessageKey, string> = {
  'error.invalid_input': '请求参数不符合要求。', 'error.unauthenticated': '请使用有效的访问令牌登录。',
  'error.forbidden': '你没有执行此操作的权限。', 'error.not_found': '未找到该资源。', 'error.conflict': '请求与已有数据冲突。',
  'error.idempotency_conflict': '此请求键已用于不同的输入。', 'error.version_conflict': '任务已发生变化，请刷新后重试。',
  'error.unsupported_state': '当前状态不支持此操作。', 'error.unavailable': '所需服务暂时不可用。', 'error.internal_error': '服务器未能完成请求。',
  'error.resume_limit': '任务已达到恢复次数上限。',
  'task.accepted': '任务已接收并排队。', 'task.cancelled': '任务已取消。', 'task.started': '任务前置检查已开始。',
  'task.recovered': '中断的执行已重新排队等待恢复。', 'task.paused': '任务正在等待经过验证的 Runner。',
  'task.resumed': '任务已排队重试前置检查。', 'task.cancel_requested': '已申请取消，执行正在停止。',
  'task.needs_human': '任务已停止，需要人工处理。', 'task.waiting_child': '任务正在等待关联子任务。',
  'task.tool_observed': '已记录一次受控工具观察。', 'task.updated': '任务已更新。',
  'tool.project_describe': '读取已登记的项目和源码版本信息。', 'tool.source_inspect': '仅通过经过验证的隔离 Runner 检查固定源码版本。',
  'tool.runner_unavailable': '经过验证的隔离 Runner 尚不可用，源码检查已阻断。',
  'mcp.start': '将已登记的固定 Git 版本审计任务入队，不代表批准或发布。',
  'mcp.query': '查询当前有权访问的任务状态。', 'mcp.events': '查询当前有权访问的任务事件。',
  'mcp.cancel': '使用任务当前版本申请取消。', 'mcp.resume': '重试暂停的前置检查，不授予批准权限。',
  'mcp.result': '任务请求已处理，请使用任务 ID 查询进度。',
  'state.queued': '排队中', 'state.running': '执行中', 'state.waiting_approval': '等待审批', 'state.waiting_input': '等待输入',
  'state.reconciling': '核对中', 'state.succeeded': '已成功', 'state.failed': '已失败', 'state.cancel_requested': '已申请取消',
  'state.cancelled': '已取消', 'state.needs_human': '需要人工处理',
};
export const messageKeySchema = z.enum(Object.keys(en) as [MessageKey, ...MessageKey[]]);
export const taskEventTypes = ['task.accepted', 'task.cancelled', 'task.started', 'task.recovered', 'task.paused', 'task.resumed',
  'task.cancel_requested', 'task.needs_human', 'task.waiting_child', 'task.tool_observed'] as const;

export function translate(locale: Locale, key: MessageKey): string { return (locale === 'zh-CN' ? zhCN : en)[key]; }

export function negotiateLocale(header?: string): Locale {
  const preferences = (header ?? '').slice(0, 2_048).split(',').map((entry, order) => {
    const [tag = '', ...options] = entry.trim().split(';');
    const quality = options.find(value => value.trim().startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
    return { tag: tag.toLowerCase(), q, order };
  }).filter(value => Number.isFinite(value.q) && value.q > 0 && value.q <= 1).sort((a, b) => b.q - a.q || a.order - b.order);
  for (const { tag } of preferences) {
    if (/^zh(?:-(?:cn|hans)(?:-cn)?)?$/.test(tag)) return 'zh-CN';
    if (/^en(?:-[a-z0-9]+)*$/.test(tag) || tag === '*') return 'en';
  }
  return 'en';
}

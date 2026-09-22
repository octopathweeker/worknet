import type { ZodError } from 'zod';

/** Report field names and constraints, never submitted values or authorization bytes. */
export function inputIssues(error: ZodError) {
  return error.issues.slice(0, 8).map(issue => {
    const field = issue.path.map(String).join('.') || 'JSON';
    let message = '格式不正确，请核对该字段。';
    if (issue.code === 'invalid_type') message = issue.expected === 'string' ? '必填，需为文本。' : issue.expected === 'number' ? '必填，需为数字；时间使用 Unix 秒数。' : `需为 ${issue.expected}。`;
    if (issue.code === 'unrecognized_keys') message = `不支持字段：${issue.keys.map(k => k.slice(0, 60)).join('、')}。`;
    if (issue.code === 'invalid_format') message = field.endsWith('contentHash') ? '需为真实来源内容的 0x 开头、64 位十六进制 hash。' : '格式不正确，请检查链接或字段格式。';
    if (issue.code === 'too_small' || issue.code === 'too_big') message = '长度、数量或数值超出允许范围，请核对任务要求。';
    return { field, message };
  });
}

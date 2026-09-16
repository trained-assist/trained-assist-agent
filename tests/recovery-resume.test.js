import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const { resumePending } = createRequire(import.meta.url)('../src/recovery-resume');
function deps(patch = {}) {
  return { pending: [{taskId:'t',username:'u',userId:0,task:'continue',sessionId:'s',startedAt:1,mode:'deep',projectId:'p',...patch}],
    runTask:vi.fn().mockResolvedValue('done'),clearPendingTask:vi.fn(),notify:vi.fn().mockResolvedValue(),record:vi.fn(),
    baseUsersDir:'/tmp/test',secrets:{},log:{warn:vi.fn(),error:vi.fn()} };
}
describe('restart recovery', () => {
  it('old running work is resumed, including web chat zero; original journal is never deleted first', async () => {
    const d=deps(); await resumePending(d);
    expect(d.clearPendingTask).not.toHaveBeenCalled();
    expect(d.runTask.mock.calls[0][0]).toMatchObject({taskId:'t',sessionId:'s',retryCount:1,mode:'deep',projectId:'p',user:{id:0}});
    expect(d.notify.mock.calls[0][1]).toContain('1/2');
  });
  it('repeated server crashes exhaust the shared budget instead of looping on each boot', async () => {
    const d=deps({retryCount:2}); await resumePending(d);
    expect(d.runTask).not.toHaveBeenCalled(); expect(d.notify.mock.calls[0][1]).toContain('2/2');
    expect(d.record).toHaveBeenCalled(); expect(d.clearPendingTask).toHaveBeenCalledWith('t');
  });
  it('already reserved shutdown retry is not counted twice', async () => {
    const d=deps({phase:'queued',retryCount:2}); await resumePending(d);
    expect(d.runTask.mock.calls[0][0].retryCount).toBe(2);
  });
  it('failed terminal notification keeps journal for delivery on next startup', async () => {
    const d=deps({retryCount:2}); d.notify.mockRejectedValue(new Error('Telegram down'));
    await resumePending(d); expect(d.runTask).not.toHaveBeenCalled();expect(d.clearPendingTask).not.toHaveBeenCalled();
  });
  it('unknown record age is retained, invalid record cannot erase another task', async () => {
    const d=deps({startedAt:undefined});d.pending.push({taskId:'invalid'});await resumePending(d);
    expect(d.runTask).toHaveBeenCalledTimes(1);expect(d.clearPendingTask).not.toHaveBeenCalled();
  });
});

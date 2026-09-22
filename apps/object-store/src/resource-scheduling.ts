/** Keep expiry/review actions timely without polling every waiting task at command speed. */
export function coordinatorDelay(commandsDue: number, activeGoals: number, deadlineSeconds: number | null, now=Date.now()) {
  const base=commandsDue>0?1500:activeGoals>0?15000:60000;
  const until=deadlineSeconds===null?Infinity:deadlineSeconds*1000-now;
  return Math.max(1000,Math.min(base,until));
}

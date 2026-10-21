export function verifyRunnerIdentity(expected: string, userOutput: string, groupOutput?: string, windows = false): { matched: boolean | null; actual: string | null } {
  if (windows) {
    if (!/^S-\d+(?:-\d+){2,}$/i.test(expected)) return { matched: null, actual: null };
    const identifiers = userOutput.match(/S-\d+(?:-\d+){2,}/gi) ?? [];
    return { matched: identifiers.length === 1 && identifiers[0]!.toUpperCase() === expected.toUpperCase(), actual: identifiers.length === 1 ? identifiers[0]! : null };
  }
  const required = /^(\d+):(\d+)$/.exec(expected);
  if (!required) return { matched: null, actual: null };
  const user = userOutput.trim(), group = groupOutput?.trim() ?? '';
  if (!/^\d+$/.test(user) || !/^\d+$/.test(group)) return { matched: false, actual: null };
  const actual = `${BigInt(user)}:${BigInt(group)}`;
  return { matched: actual === `${BigInt(required[1]!)}:${BigInt(required[2]!)}`, actual };
}

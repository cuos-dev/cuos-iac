export function containerStatus(statusStr = '') {
  if (statusStr.includes('healthy')) return { cls: 'badge-green', label: 'healthy', icon: 'ti-circle-check' };
  if (statusStr.startsWith('Up'))    return { cls: 'badge-blue',  label: 'running', icon: 'ti-circle-filled' };
  return                                    { cls: 'badge-red',   label: 'stopped', icon: 'ti-circle-x' };
}

export function iacStatusDot(iacState = '') {
  if (iacState === 'running')  return 'green';
  if (iacState === 'updating') return 'warn';
  return 'err';
}

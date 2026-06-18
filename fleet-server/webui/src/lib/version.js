export function computeLatest(devices, field) {
  return devices.reduce((max, d) => {
    const v = d[field];
    if (!v) return max;
    return !max || v.localeCompare(max, undefined, { numeric: true }) > 0 ? v : max;
  }, null);
}

export function isOutdated(ver, latest) {
  return !!(ver && latest && ver !== latest);
}

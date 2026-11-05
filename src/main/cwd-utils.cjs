function isValidCwd(cwd, isWindows) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  return isWindows
    ? /^[a-zA-Z]:[\\/]/.test(cwd) || /^[\\/]{2}/.test(cwd)
    : cwd.startsWith("/");
}

module.exports = { isValidCwd };

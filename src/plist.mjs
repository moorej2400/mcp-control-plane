export function renderLaunchAgentPlist({ args = [], label, logDir = ".", program, startInterval }) {
  const intervalBlock = startInterval
    ? `\n  <key>StartInterval</key>\n  <integer>${startInterval}</integer>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>${intervalBlock}
  <key>StandardOutPath</key>
  <string>${xml(logDir)}/${xml(label)}.out.log</string>
  <key>StandardErrorPath</key>
  <string>${xml(logDir)}/${xml(label)}.err.log</string>
</dict>
</plist>
`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Terminals answer queries from the running app on their own (cursor position,
// device attributes, mode reports, OSC colour replies) and send focus in/out events.
// Those aren't the user typing, so they must not change who owns the PTY size,
// and only one terminal's answers should reach the app.
const AUTO_RESPONSE = new RegExp([
  '\\x1b\\[\\d+;\\d+R',                 // cursor position report
  '\\x1b\\[[?>=][\\d;]*c',              // primary / secondary device attributes
  '\\x1b\\[\\??[\\d;]*\\$y',             // DECRPM mode report
  '\\x1b\\[\\d*n',                      // device status report
  '\\x1b\\[[\\d;]+t',                   // window size reports
  '\\x1b\\[\\?[\\d;]*u',                // kitty keyboard flags
  '\\x1b\\[[IO]',                       // focus in / out
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC replies
  '\\x1bP[\\s\\S]*?\\x1b\\\\',          // DCS replies
].join('|'), 'g');

export function isAutoResponse(d) {
  return d.length > 0 && d.replace(AUTO_RESPONSE, '') === '';
}

var responseLimits = {
  forecast: 256 * 1024,
  dailyForecast: 64 * 1024,
  geocode: 64 * 1024,
  location: 1024
}

function curlCommand(url, timeoutSeconds, maxBytes) {
  // Ignore curlrc so extra URLs or decompression cannot bypass the body limit.
  return ["curl", "-q", "-fsS", "--max-time", String(timeoutSeconds),
    "--max-filesize", String(maxBytes), url]
}

function responseText(text, exitCode, exitStatus, maxBytes) {
  // Even valid JSON can be the prefix of a failed or size-limited transfer.
  // QProcess::NormalExit is 0; Quickshell does not expose that enum in QML.
  if (exitStatus !== 0 || exitCode !== 0)
    throw new Error("Request failed with exit code " + exitCode)

  var raw = String(text || "")
  if (raw.length > maxBytes) throw new Error("Response exceeds " + maxBytes + " bytes")

  var bytes = 0
  for (var i = 0; i < raw.length; i++) {
    var code = raw.charCodeAt(i)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff
        && i + 1 < raw.length && raw.charCodeAt(i + 1) >= 0xdc00
        && raw.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4
      i++
    } else bytes += 3
    if (bytes > maxBytes) throw new Error("Response exceeds " + maxBytes + " bytes")
  }

  raw = raw.trim()
  if (!raw) throw new Error("Empty response")
  return raw
}

if (typeof module !== "undefined") {
  module.exports = {
    responseLimits: responseLimits,
    curlCommand: curlCommand,
    responseText: responseText
  }
}

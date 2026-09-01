function tryJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch (err) {
    return null
  }
}

function stitchAIGatherMessages(raw) {
  var messages = tryJsonParse(raw)
  if (!messages || !messages.length) return ''

  return messages
    .map(function (m) {
      return (m.role === 'assistant' ? 'Q: ' : 'A: ') + m.content
    })
    .join('\n')
}

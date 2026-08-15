function getConfig(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key)
  if (value === null) throw new Error('Missing script property: ' + key)
  return value
}

function getOptionalConfig(key, fallback) {
  var value = PropertiesService.getScriptProperties().getProperty(key)
  return value === null ? fallback : value
}

function getConfigList(key, fallback) {
  var value = getOptionalConfig(key, null)
  if (value === null) return fallback || []
  return value
    .split(',')
    .map(function (item) {
      return item.trim()
    })
    .filter(function (item) {
      return item.length > 0
    })
}

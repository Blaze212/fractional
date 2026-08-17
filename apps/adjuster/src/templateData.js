function loadEnums() {
  var file = DriveApp.getFileById(getConfig('ENUMS_FILE_ID'))
  return JSON.parse(file.getBlob().getDataAsString())
}

function loadGlossary() {
  var file = DriveApp.getFileById(getConfig('GLOSSARY_FILE_ID'))
  return JSON.parse(file.getBlob().getDataAsString())
}

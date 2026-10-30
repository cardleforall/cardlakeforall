const { item } = require('../_lib/resources');
const { family } = require('../_lib/resource-configs');
// PATCH / DELETE update family_updates; writes require a resolved tenant via resolveWriterTenant() in item().
module.exports = item(family);

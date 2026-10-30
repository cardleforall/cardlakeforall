const { item } = require('../_lib/resources');
const { kanban } = require('../_lib/resource-configs');
// PATCH / DELETE update kanban_items; writes require a resolved tenant via resolveWriterTenant() in item().
module.exports = item(kanban);

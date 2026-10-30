const { collection } = require('../_lib/resources');
const { kanban } = require('../_lib/resource-configs');
// GET list / POST insert into kanban_items; POST authentication is enforced by collection().
module.exports = collection(kanban);

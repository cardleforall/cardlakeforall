const { collection } = require('../_lib/resources');
const { talkingPoints } = require('../_lib/resource-configs');
// GET list / POST insert into talking_points; POST authentication is enforced by collection().
module.exports = collection(talkingPoints);

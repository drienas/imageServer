const axios = require('axios');

const port = process.env.SERVER_PORT || 3333;

(async () => {
  try {
    let data = await axios.get(`http://localhost:${port}`);
    if (data.status !== 200) process.exit(1);
    process.exit(0);
  } catch (err) {
    process.exit(1);
  }
})();

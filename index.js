const express = require('express');
const mongoose = require('mongoose');
const jimp = require('jimp');
const cors = require('cors');

const mongo = process.env.MONGO_DB || 'jobrouter6:27017';
const port = process.env.SERVER_PORT || 3333;

const mongoUrl = `mongodb://${mongo}/cardata`;

let BRAND,
  FONT = null;

const imageSchema = new mongoose.Schema(
  {
    image: {
      type: Buffer,
    },
    tags: [String],
    positionIdentifier: Number,
  },
  { timestamps: true }
);

const carSchema = new mongoose.Schema(
  {
    vin: { type: String, index: true },
    images: [
      {
        positionIdentifier: Number,
        imageId: mongoose.Types.ObjectId,
      },
    ],
  },
  { timestamps: true }
);

let Image, Car;

const app = express();

app.use(cors());

app.get('/', (req, res) => res.status(200).send());

app.get('/api/v1/images/status/:vin', async (req, res) => {
  try {
    let vin = req.params.vin;
    if (!/^\w{17}$/g.test(vin)) {
      res.status(400).json({
        success: false,
        found: false,
        error: `${vin} is not a valid VIN.`,
      });
      return;
    }
    let carData = await Car.findOne({ vin });
    if (!carData) {
      res.status(200).json({
        success: true,
        found: false,
      });
      return;
    } else {
      res.status(200).json({
        success: true,
        found: true,
        images: carData.images
          .sort((a, b) => a.positionIdentifier - b.positionIdentifier)
          .map((x) => `/api/v1/images/raw/${vin}/${x.positionIdentifier}`),
      });
    }
  } catch (err) {
    res.json(500).json({ success: false, found: false, error: err });
  }
});

app.get('/api/v1/images/raw/:vin/:positionIdentifier', async (req, res) => {
  try {
    let vin = req.params.vin;
    let positionIdentifier = req.params.positionIdentifier;
    if (!/^\w{17}$/g.test(vin)) {
      res.status(400).json({
        success: false,
        found: false,
        error: `${vin} is not a valid VIN.`,
      });
      return;
    }
    let carData = await Car.findOne({ vin });
    if (!carData) {
      res.status(404).send();
      return;
    } else {
      let image = carData.images.find(
        (x) => x.positionIdentifier == positionIdentifier
      );
      if (!image) {
        res.status(404).send();
        return;
      }
      let imageId = image.imageId;
      image = await Image.findOne({ _id: imageId });
      if (!image) {
        res.status(404).send();
        return;
      }
      res.set('Content-Type', 'image/jpeg');
      res.status(200).send(image.image);
    }
  } catch (err) {
    res.json(500).json({ success: false, found: false, error: err });
  }
});

const brandImage = async (im) => {
  let imageTmp = await jimp.read(im);
  imageTmp = await imageTmp.composite(
    BRAND,
    0,
    imageTmp.bitmap.height - BRAND.bitmap.height
  );
  return imageTmp.getBufferAsync(jimp.MIME_JPEG);
};

const brandVIN = async (im, vin) => {
  let imageTmp = await jimp.read(im);
  imageTmp.print(FONT, 10, 10, vin);
  return imageTmp.getBufferAsync(jimp.MIME_JPEG);
};

app.get('/api/v1/images/brand/:vin/:positionIdentifier', async (req, res) => {
  try {
    let vin = req.params.vin;
    let positionIdentifier = req.params.positionIdentifier;
    if (!/^\w{17}$/g.test(vin)) {
      res.status(400).json({
        success: false,
        found: false,
        error: `${vin} is not a valid VIN.`,
      });
      return;
    }
    let carData = await Car.findOne({ vin });
    if (!carData) {
      res.status(404).send();
      return;
    } else {
      let image = carData.images.find(
        (x) => x.positionIdentifier == positionIdentifier
      );
      if (!image) {
        res.status(404).send();
        return;
      }
      let imageId = image.imageId;
      image = await Image.findOne({ _id: imageId });
      if (!image) {
        res.status(404).send();
        return;
      }
      res.set('Content-Type', 'image/jpeg');
      let im = image.image;
      if (positionIdentifier == 1) im = await brandImage(im);

      res.status(200).send(im);
    }
  } catch (err) {
    res.json(500).json({ success: false, found: false, error: err });
  }
});

app.get('/api/v1/images/status/changedsince/:seconds', async (req, res) => {
  try {
    let sec = req.params.seconds;
    let timestamp = Date.now() - sec * 1000;
    let data = await Car.find({ updatedAt: { $gte: timestamp } });
    data = data.map((x) => x.vin);
    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err });
  }
});

console.log(`Connecting to MongoDB @ ${mongoUrl}`);
mongoose.connect(mongoUrl, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useCreateIndex: true,
});

mongoose.connection.on('connected', (err) => {
  console.log(`Connceted to MongoDB`);
  app.listen(port, async () => {
    BRAND = await jimp.read(`./LogoBrand.png`);
    FONT = await jimp.loadFont(jimp.FONT_SANS_32_BLACK);
    console.log(`App listening on port ${port}`);
    Image = mongoose.model('Image', imageSchema);
    Car = mongoose.model('Car', carSchema);
  });
});

mongoose.connection.on('error', (err) => {
  console.error(err);
  process.exit(0);
});

mongoose.connection.on('disconnected', (msg) => {
  console.error(msg);
  process.exit(0);
});

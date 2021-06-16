const express = require('express');
const mongoose = require('mongoose');
const jimp = require('jimp');
const cors = require('cors');

const mongo = process.env.MONGO_DB || 'jobrouter6:27017';
const port = process.env.SERVER_PORT || 3333;

const mongoUrl = `mongodb://${mongo}/cardata`;

let BRAND;
FONT = null;

let BRANDS = {
  BRAND: null,
  BRANDDSG: null,
  BRANDAPPROVED: null,
  BRANDBOR: null,
};

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
    linked: Boolean,
  },
  { timestamps: true }
);

let Image, Car;

const app = express();

app.use(cors());

app.get('/', (req, res) => res.status(200).send());

app.get('/images/v1/status/:vin', async (req, res) => {
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
          .map((x) => `/${vin}/${x.positionIdentifier}`),
      });
    }
  } catch (err) {
    res.json(500).json({ success: false, found: false, error: err });
  }
});

app.get('/images/v1/raw/:vin/:positionIdentifier', async (req, res) => {
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

const brandImage = async (im, brand = 'BRAND') => {
  let imageTmp = await jimp.read(im);
  imageTmp = await imageTmp.composite(
    BRANDS[brand],
    0,
    imageTmp.bitmap.height - BRANDS[brand].bitmap.height
  );
  return imageTmp.getBufferAsync(jimp.MIME_JPEG);
};

const brandVIN = async (im, vin) => {
  let imageTmp = await jimp.read(im);
  imageTmp.print(FONT, 10, 10, vin);
  return imageTmp.getBufferAsync(jimp.MIME_JPEG);
};

app.get('/images/v1/brand/:vin/:positionIdentifier', async (req, res) => {
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

app.get(
  '/images/v2/brand/:brandId/:vin/:positionIdentifier',
  async (req, res) => {
    try {
      let vin = req.params.vin;
      let brandId = req.params.brandId;
      if (!Object.keys(BRANDS).includes(brandId)) {
        res.status(400).json({
          success: false,
          message: 'Invalid brandId set',
        });
        return;
      }
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
        if (positionIdentifier == 1) im = await brandImage(im, brandId);

        res.status(200).send(im);
      }
    } catch (err) {
      res.json(500).json({ success: false, found: false, error: err });
    }
  }
);

app.get('/images/v1/status/changedsince/:seconds', async (req, res) => {
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

app.get('/images/v1/link/:from/:to', async (req, res) => {
  try {
    let from = req.params.from;
    let to = req.params.to;
    for (let x of [from, to]) {
      if (!/^\w{17}$/g.test(x)) {
        res.status(400).json({
          success: false,
          found: false,
          error: `${x} is not a valid VIN.`,
        });
        return;
      }
    }
    let carData = await Car.findOne({ vin: from });
    let carCheck = await Car.findOne({ vin: to });
    if (carCheck) throw `VIN ${to} already exists in database.`;
    if (!carData) {
      res
        .status(404)
        .json({ success: false, error: `Car to link from not found.` });
      return;
    }
    let images = carData.images;
    let vin = to;
    const query = await new Car({
      vin,
      images,
      linked: true,
    }).save();
    res.status(200).json({ success: true, query });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err });
  }
});

app.delete('/images/v1/link/:vin', async (req, res) => {
  let vin = req.params.vin;
  if (!/^\w{17}$/g.test(vin)) {
    res.status(400).json({
      success: false,
      found: false,
      error: `${vin} is not a valid VIN.`,
    });
  }
  try {
    let carData = await Car.findOne({ vin });
    if (!carData) {
      res
        .status(404)
        .json({ success: false, error: `No cardata found for ${vin}` });
      return;
    }
    if (!carData.linked) {
      res.status(400).json({
        success: false,
        error: `${vin} contains original pictures and cannot be deleted.`,
      });
      return;
    }
    let deletedData = await Car.deleteOne({ _id: carData._id });
    console.log(deletedData);
    res.status(200).json({ success: true, deletedData });
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
    BRANDS = {
      BRAND: await jimp.read(`./LogoBrand.png`),
      BRANDDSG: await jimp.read(`./LogoDSG.png`),
      BRANDAPPROVED: await jimp.read(`./LogoBORApproved.png`),
      BRANDBOR: await jimp.read(`./LogoBOR.png`),
    };
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

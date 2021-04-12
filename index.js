const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const mongo = process.env.MONGO_DB || 'jobrouter6:27017';
const port = process.env.SERVER_PORT || 3333;

const mongoUrl = `mongodb://${mongo}/cardata`;

const imageSchema = new mongoose.Schema({
  image: {
    type: Buffer,
  },
  tags: [String],
  positionIdentifier: Number,
});

const carSchema = new mongoose.Schema({
  vin: { type: String, index: true },
  images: [
    {
      positionIdentifier: Number,
      imageId: mongoose.Types.ObjectId,
    },
  ],
});

let Image, Car;

const app = express();

app.use(cors());

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

app.listen(port, async () => {
  console.log(`App listening on port ${port}`);
  const db = await mongoose.connect(mongoUrl, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });
  Image = mongoose.model('Image', imageSchema);
  Car = mongoose.model('Car', carSchema);
});

mongoose.connection.on('error', (err) => {
  console.error(err);
  process.exit(0);
});

mongoose.connection.on('disconnected', (msg) => {
  console.error(msg);
  process.exit(0);
});

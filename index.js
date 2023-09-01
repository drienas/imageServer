import express from 'express';
import mongoose from 'mongoose';
import jimp from 'jimp';
import cors from 'cors';
import { BasicStrategy } from 'passport-http';
import passport from 'passport';
import cache from 'memory-cache';
// import sizeOf from 'image-size';
import * as dotenv from 'dotenv';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const mongo = process.env.MONGO_DB;
const port = process.env.SERVER_PORT;
const AUTHUSER = process.env.AUTHUSER;
const AUTHPASSWORD = process.env.AUTHPASSWORD;

passport.use(
  new BasicStrategy((user, pw, done) => {
    try {
      if (user !== AUTHUSER) return done(null, false);
      if (pw !== AUTHPASSWORD) return done(null, false);
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

const mongoUrl = `mongodb://${mongo}/cardata`;
const basePathLocal = path.normalize('own');

let BRAND = null;

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

const postProcessImage = (req, img) => {
  return new Promise(async (resolve, reject) => {
    try {
      // let dim = sizeOf(img);
      // if (dim.width > 1920) {
      //   let pic = await jimp.read(img);
      //   pic = await pic.resize(1920, jimp.AUTO);
      //   img = await pic.getBufferAsync(jimp.MIME_JPEG);
      // }
      let vin = req.params.vin;
      let positionIdentifier = req.params.positionIdentifier;
      let shrink = req.query;
      if (!shrink.shrink) {
        resolve(img);
        return;
      }
      shrink = shrink.shrink;
      let id = `${vin}/${positionIdentifier}/${shrink}`;
      let cached = cache.get(id);
      if (cached) {
        resolve(cached);
      } else {
        let pic = await jimp.read(img);
        pic = await pic.resize(parseInt(shrink), jimp.AUTO);
        pic = await pic.getBufferAsync(jimp.MIME_JPEG);
        resolve(pic);
        cache.put(id, pic, 30 * 60 * 1000);
      }
    } catch (err) {
      console.error(err);
      resolve(img);
    }
  });
};

let Image, Car;

const findFromOwnStore = (vin) => {
  return new Promise((resolve, reject) => {
    let found = false;
    let images = [];
    const fullPath = path.join(basePathLocal, vin);
    if (!fs.existsSync(fullPath)) {
      resolve({ found });
      return;
    }
    let files = fs.readdirSync(fullPath);
    let r = new RegExp(`^${vin}_\\d{1,2}.\\w+$`);
    files = files.filter((x) => r.test(x));
    files = files.map((x) => ({
      vin,
      positionIdentifier: parseInt(x.split('_')[1].split('.')[0]),
      fileName: x,
    }));
    found = true;
    resolve({
      found,
      images: files,
      local: true,
    });
  });
};

const getImageBuffer = (p) => {
  const fullPath = path.join(basePathLocal, p);
  return { image: fs.readFileSync(fullPath) };
};

const brandImage = async (im, brand = 'BRAND') => {
  if (!BRANDS[brand]) return im;
  let imageTmp = await jimp.read(im);
  imageTmp = await imageTmp.composite(
    BRANDS[brand],
    0,
    imageTmp.bitmap.height - BRANDS[brand].bitmap.height
  );
  return imageTmp.getBufferAsync(jimp.MIME_JPEG);
};

const handleCarData = (carData, vin, positionIdentifier, res) => {
  return new Promise(async (resolve, reject) => {
    let image = null;
    if (!carData) {
      let hasLocalImage = await findFromOwnStore(vin);
      if (!hasLocalImage.found) {
        res.status(404).send();
        reject();
        return;
      }
      let positionImage = hasLocalImage.images.find(
        (x) => x.positionIdentifier == positionIdentifier
      );
      if (!positionImage) {
        res.status(404).send();
        reject();
        return;
      }
      image = getImageBuffer(`${positionImage.vin}/${positionImage.fileName}`);
    } else {
      image = carData.images.find(
        (x) => x.positionIdentifier == positionIdentifier
      );
      if (!image) {
        res.status(404).send();
        reject();
        return;
      }
      let imageId = image.imageId;
      image = await Image.findOne({ _id: imageId });
      if (!image) {
        res.status(404).send();
        reject();
        return;
      }
    }
    resolve(image);
  });
};

const app = express();
app.use(morgan('[:date] :method :url :status - :response-time ms'));
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
    let returnData = {
      success: false,
      found: false,
      images: [],
    };
    if (!carData) {
      let hasLocalImage = await findFromOwnStore(vin);
      if (!hasLocalImage.found) {
        res.status(200).json({
          success: true,
          found: false,
        });
        return;
      }
      carData = hasLocalImage;
    }
    returnData = {
      success: true,
      found: true,
      images: carData.images
        .sort((a, b) => a.positionIdentifier - b.positionIdentifier)
        .map((x) => `/${vin}/${x.positionIdentifier}`),
      photofairy: carData.local ? !carData.local : true,
      createdAt: carData.createdAt,
      updatedAt: carData.updatedAt,
    };
    res.status(200).json(returnData);
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

    handleCarData(carData, vin, positionIdentifier, res)
      .then(async (image) => {
        res.set('Content-Type', 'image/jpeg');
        let i = image.image;
        i = await postProcessImage(req, i);
        res.status(200).send(i);
      })
      .catch(() => {});
  } catch (err) {
    console.error(err);
    res.json(500).json({ success: false, found: false, error: err });
  }
});

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
    handleCarData(carData, vin, positionIdentifier, res)
      .then(async (image) => {
        res.set('Content-Type', 'image/jpeg');
        let im = image.image;
        if (positionIdentifier == 1) im = await brandImage(im);
        res.status(200).send(im);
      })
      .catch(() => {});
  } catch (err) {
    res.json(500).json({ success: false, found: false, error: err });
  }
});

// app.get(
//   '/images/v2/brand/:brandId/:vin/:positionIdentifier',
//   async (req, res) => {
//     try {
//       let vin = req.params.vin;
//       let brandId = req.params.brandId;
//       if (!Object.keys(BRANDS).includes(brandId)) {
//         res.status(400).json({
//           success: false,
//           message: 'Invalid brandId set',
//         });
//         return;
//       }
//       let positionIdentifier = req.params.positionIdentifier;
//       if (!/^\w{17}$/g.test(vin)) {
//         res.status(400).json({
//           success: false,
//           found: false,
//           error: `${vin} is not a valid VIN.`,
//         });
//         return;
//       }
//       let carData = await Car.findOne({ vin });

//       handleCarData(carData, vin, positionIdentifier, res)
//         .then(async (image) => {
//           res.set('Content-Type', 'image/jpeg');
//           let im = image.image;
//           im = await postProcessImage(req, im);
//           if (positionIdentifier == 1) im = await brandImage(im, brandId);
//           res.status(200).send(im);
//         })
//         .catch(() => {});
//     } catch (err) {
//       res.json(500).json({ success: false, found: false, error: err });
//     }
//   }
// );

app.get(
  /^\/images\/v2\/brand(?:\/(\w+))(?:\/(\w{17}))(?:\/(\d{1,2}))(\.jpg)??/,
  async (req, res) => {
    try {
      let vin = req.params[1];
      let brandId = req.params[0];
      if (!Object.keys(BRANDS).includes(brandId)) {
        res.status(400).json({
          success: false,
          message: 'Invalid brandId set',
        });
        return;
      }
      let positionIdentifier = req.params[2];
      if (!/^\w{17}$/g.test(vin)) {
        res.status(400).json({
          success: false,
          found: false,
          error: `${vin} is not a valid VIN.`,
        });
        return;
      }
      let carData = await Car.findOne({ vin });

      handleCarData(carData, vin, positionIdentifier, res)
        .then(async (image) => {
          res.set('Content-Type', 'image/jpeg');
          let im = image.image;
          im = await postProcessImage(req, im);
          if (positionIdentifier == 1) im = await brandImage(im, brandId);
          res.status(200).send(im);
        })
        .catch(() => {});
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
    return;
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
    res.status(200).json({ success: true, deletedData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err });
  }
});

app.delete(
  '/images/v1/original/:vin',
  passport.authenticate('basic', { session: false }),
  async (req, res) => {
    let vin = req.params.vin;
    if (!/^\w{17}$/g.test(vin)) {
      res.status(400).json({
        success: false,
        found: false,
        error: `${vin} is not a valid VIN.`,
      });
      return;
    }
    try {
      let carData = await Car.findOne({ vin });
      if (!carData) {
        res
          .status(404)
          .json({ success: false, error: `No cardata found for ${vin}` });
        return;
      }
      let deletedData = await Car.deleteOne({ _id: carData._id });
      res.status(200).json({ success: true, deletedData });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err });
    }
  }
);

console.log(`Connecting to MongoDB @ ${mongoUrl}`);
mongoose.connect(mongoUrl, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useCreateIndex: true,
});

mongoose.connection.on('connected', (err) => {
  console.log(`Connected to MongoDB...`);
  app.listen(port, async () => {
    BRAND = await jimp.read(`./Header_Petrol.png`);
    BRANDS = {
      BRAND: await jimp.read(`./Header_Petrol.png`),
      BRANDDSG: await jimp.read(`./Header_Petrol.png`),
      BRANDAPPROVED: await jimp.read(`./Header_Petrol.png`),
      BRANDBOR: await jimp.read(`./Header_Petrol.png`),
      // BRANDBOR: null,
    };
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

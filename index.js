import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import { BasicStrategy } from "passport-http";
import passport from "passport";
import cache from "memory-cache";
import * as dotenv from "dotenv";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import Redis from "ioredis";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const mongo = process.env.MONGO_DB;
const port = process.env.SERVER_PORT;
const AUTHUSER = process.env.AUTHUSER;
const AUTHPASSWORD = process.env.AUTHPASSWORD;

// Redis Client Setup
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on("error", (err) => console.error("Redis Client Error", err));
redis.on("connect", () => console.log("Connected to Redis..."));

// Cache TTL Konstanten
const CACHE_TTL = {
  IMAGE: 30 * 60, // 30 Minuten
  STATUS: 5 * 60, // 5 Minuten
  CHANGES: 60, // 1 Minute
};

// Cache Hilfsfunktionen
const getCacheKey = (type, ...args) => {
  switch (type) {
    case "image":
      const [vin, positionIdentifier, shrink, brand] = args;
      return `image:${vin}:${positionIdentifier}:${shrink || "original"}:${
        brand || "none"
      }`;
    case "status":
      return `status:${args[0]}`; // VIN
    case "changes":
      return `changes:${args[0]}`; // Seconds
    default:
      return null;
  }
};

const getFromCache = async (key) => {
  try {
    // Erst im Memory-Cache suchen
    const memoryResult = cache.get(key);
    if (memoryResult) {
      return { hit: true, data: memoryResult, source: "memory" };
    }

    // Dann in Redis suchen
    const redisResult = await redis.get(key);
    if (redisResult) {
      // Wenn in Redis gefunden, auch in Memory-Cache speichern
      const data = JSON.parse(redisResult);
      cache.put(key, data, 5 * 60 * 1000); // 5 Minuten Memory-Cache
      return { hit: true, data, source: "redis" };
    }

    return { hit: false };
  } catch (err) {
    console.error("Cache Error:", err);
    return { hit: false, error: err };
  }
};

const setInCache = async (key, data, ttl) => {
  try {
    // In Memory-Cache speichern
    cache.put(key, data, 5 * 60 * 1000); // 5 Minuten

    // In Redis speichern
    await redis.setex(key, ttl, JSON.stringify(data));
  } catch (err) {
    console.error("Cache Set Error:", err);
  }
};

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
const basePathLocal = path.normalize("own");

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
      // Bei Regex-Route sind die Parameter in req.params[1] und req.params[2]
      let vin = req.params.vin || req.params[1];
      let positionIdentifier = req.params.positionIdentifier || req.params[2];
      let shrink = req.query.shrink;

      if (!shrink) {
        resolve(img);
        return;
      }

      const cacheKey = getCacheKey("image", vin, positionIdentifier, shrink);
      const cached = await getFromCache(cacheKey);

      if (cached.hit) {
        console.log(`Cache hit for ${cacheKey} from ${cached.source}`);
        resolve(Buffer.from(cached.data, "base64"));
        return;
      }

      let pic = await sharp(img)
        .resize(parseInt(shrink))
        .jpeg({ quality: 85 })
        .toBuffer();

      // Cache das verarbeitete Bild
      await setInCache(cacheKey, pic.toString("base64"), CACHE_TTL.IMAGE);
      resolve(pic);
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
      positionIdentifier: parseInt(x.split("_")[1].split(".")[0]),
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

const brandImage = async (im, brand = "BRAND") => {
  if (!BRANDS[brand]) return im;

  try {
    // Generiere einen eindeutigen Cache-Key basierend auf dem Bildinhalt und Brand
    const imageHash = Buffer.from(im).length.toString(36);
    const cacheKey = getCacheKey("image", "branded", imageHash, null, brand);
    const cached = await getFromCache(cacheKey);

    if (cached.hit) {
      console.log(`Cache hit for branded image from ${cached.source}`);
      return Buffer.from(cached.data, "base64");
    }

    // Lade das Originalbild und den Footer
    const originalImage = sharp(im);
    const footerImage = BRANDS[brand].clone(); // Clone um eine frische Instanz zu bekommen

    // Hole die Metadaten beider Bilder
    const [originalMeta, footerMeta] = await Promise.all([
      originalImage.metadata(),
      footerImage.metadata(),
    ]);

    // Prüfe ob der Footer breiter oder schmaler ist als das Originalbild
    if (footerMeta.width !== originalMeta.width) {
      // Skaliere den Footer auf die Breite des Originalbildes
      await footerImage.resize(originalMeta.width, null, {
        fit: "contain",
      });
    }

    // Composite das Footer-Bild über das Originalbild
    const result = await originalImage
      .composite([
        {
          input: await footerImage.toBuffer(),
          gravity: "south",
        },
      ])
      .jpeg({ quality: 85 })
      .toBuffer();

    // Cache das Ergebnis
    await setInCache(cacheKey, result.toString("base64"), CACHE_TTL.IMAGE);

    return result;
  } catch (err) {
    console.error("Error in brandImage:", err);
    return im;
  }
};

const handleCarData = (carData, vin, positionIdentifier, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      // Prüfe zuerst den Cache
      const cacheKey = getCacheKey(
        "image",
        vin,
        positionIdentifier,
        "original"
      );
      const cached = await getFromCache(cacheKey);

      if (cached.hit) {
        console.log(`Cache hit for original image from ${cached.source}`);
        resolve({ image: Buffer.from(cached.data, "base64") });
        return;
      }

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
        image = getImageBuffer(
          `${positionImage.vin}/${positionImage.fileName}`
        );
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

      // Cache das Originalbild
      await setInCache(
        cacheKey,
        image.image.toString("base64"),
        CACHE_TTL.IMAGE
      );

      resolve(image);
    } catch (err) {
      console.error("Error in handleCarData:", err);
      reject(err);
    }
  });
};

const app = express();
app.use(morgan("[:date] :method :url :status - :response-time ms"));
app.use(cors());

app.get("/", (req, res) => res.status(200).send());

app.get("/images/v1/status/:vin", async (req, res) => {
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

    // Prüfe Cache
    const cacheKey = getCacheKey("status", vin);
    const cached = await getFromCache(cacheKey);

    if (cached.hit) {
      console.log(`Cache hit for status from ${cached.source}`);
      res.status(200).json(cached.data);
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
        const notFoundResponse = {
          success: true,
          found: false,
        };
        // Cache auch negative Ergebnisse
        await setInCache(cacheKey, notFoundResponse, CACHE_TTL.STATUS);
        res.status(200).json(notFoundResponse);
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

    // Cache das Ergebnis
    await setInCache(cacheKey, returnData, CACHE_TTL.STATUS);

    res.status(200).json(returnData);
  } catch (err) {
    res.json(500).json({ success: false, found: false, error: err });
  }
});

app.get("/images/v1/raw/:vin/:positionIdentifier", async (req, res) => {
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
        res.set("Content-Type", "image/jpeg");
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

app.get("/images/v1/brand/:vin/:positionIdentifier", async (req, res) => {
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
        res.set("Content-Type", "image/jpeg");
        let im = image.image;
        im = await postProcessImage(req, im);
        if (positionIdentifier == 1) im = await brandImage(im);
        res.status(200).send(im);
      })
      .catch(() => {});
  } catch (err) {
    res.json(500).json({ success: false, found: false, error: err });
  }
});

app.get(
  /^\/images\/v2\/brand(?:\/(\w+))(?:\/(\w{17}))(?:\/(\d{1,2}))(\.jpg)??/,
  async (req, res) => {
    try {
      let vin = req.params[1];
      let brandId = req.params[0];
      let positionIdentifier = req.params[2];

      if (!Object.keys(BRANDS).includes(brandId)) {
        res.status(400).json({
          success: false,
          message: "Invalid brandId set",
        });
        return;
      }

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
          res.set("Content-Type", "image/jpeg");
          let im = image.image;

          // Erst das Bild verkleinern, wenn nötig
          const processedImage = await postProcessImage(
            {
              params: { vin, positionIdentifier },
              query: req.query,
            },
            im
          );

          // Dann das Branding hinzufügen
          if (positionIdentifier == 1) {
            im = await brandImage(processedImage, brandId);
          } else {
            im = processedImage;
          }

          res.status(200).send(im);
        })
        .catch(() => {});
    } catch (err) {
      res.json(500).json({ success: false, found: false, error: err });
    }
  }
);

app.get("/images/v1/status/changedsince/:seconds", async (req, res) => {
  try {
    let sec = req.params.seconds;

    // Prüfe Cache
    const cacheKey = getCacheKey("changes", sec);
    const cached = await getFromCache(cacheKey);

    if (cached.hit) {
      console.log(`Cache hit for changes from ${cached.source}`);
      res.status(200).json(cached.data);
      return;
    }

    let timestamp = Date.now() - sec * 1000;
    let data = await Car.find({ updatedAt: { $gte: timestamp } });
    const response = {
      success: true,
      data: data.map((x) => x.vin),
    };

    // Cache das Ergebnis
    await setInCache(cacheKey, response, CACHE_TTL.CHANGES);

    res.status(200).json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err });
  }
});

app.get("/images/v1/link/:from/:to", async (req, res) => {
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

app.delete("/images/v1/link/:vin", async (req, res) => {
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
  "/images/v1/original/:vin",
  passport.authenticate("basic", { session: false }),
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

mongoose.connection.on("connected", (err) => {
  console.log(`Connected to MongoDB...`);
  app.listen(port, async () => {
    BRAND = sharp(`./Header_Petrol.png`);
    BRANDS = {
      BRAND: sharp(`./Header_Petrol.png`),
      BRANDDSG: sharp(`./Header_Petrol.png`),
      BRANDAPPROVED: sharp(`./Header_Petrol.png`),
      BRANDBOR: sharp(`./Header_Petrol.png`),
    };
    console.log(`App listening on port ${port}`);
    Image = mongoose.model("Image", imageSchema);
    Car = mongoose.model("Car", carSchema);
  });
});

mongoose.connection.on("error", (err) => {
  console.error(err);
  process.exit(0);
});

mongoose.connection.on("disconnected", (msg) => {
  console.error(msg);
  process.exit(0);
});

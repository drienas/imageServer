import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import { BasicStrategy } from "passport-http";
import passport from "passport";
import * as dotenv from "dotenv";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import Redis from "ioredis";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const mongo = process.env.MONGO_DB;
const port = process.env.SERVER_PORT;
const AUTHUSER = process.env.AUTHUSER;
const AUTHPASSWORD = process.env.AUTHPASSWORD;

// S3/MinIO Client Setup
const s3Client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

const MINIO_BUCKET = process.env.MINIO_BUCKET || "images";
const MINIO_OWN_FOLDER =
  process.env.MINIO_OWN_FOLDER || "DSG-Root/Fahrzeugbilder";

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
    const redisResult = await redis.get(key);
    if (redisResult) {
      return { hit: true, data: JSON.parse(redisResult), source: "redis" };
    }
    return { hit: false };
  } catch (err) {
    console.error("Cache Error:", err);
    return { hit: false, error: err };
  }
};

const setInCache = async (key, data, ttl) => {
  try {
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

const findFromOwnStore = async (vin) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: MINIO_BUCKET,
      Prefix: `${MINIO_OWN_FOLDER}/${vin}/`,
    });

    const response = await s3Client.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      return { found: false };
    }

    const files = response.Contents.map((obj) => obj.Key)
      .filter((key) => {
        // Matcht z.B. DSG-Root/Fahrzeugbilder/1C4BU0000FPB06732/1C4BU0000FPB06732_1.jpeg
        const r = new RegExp(
          `^${MINIO_OWN_FOLDER}/${vin}/${vin}_(\\d{1,2})\\.\\w+$`
        );
        return r.test(key);
      })
      .map((key) => {
        const match = key.match(new RegExp(`${vin}_(\\d{1,2})\\.`));
        return {
          vin,
          positionIdentifier: match ? parseInt(match[1]) : null,
          fileName: key.split("/").pop(),
        };
      });

    return {
      found: files.length > 0,
      images: files,
      local: true,
    };
  } catch (err) {
    console.error("Error in findFromOwnStore:", err);
    return { found: false };
  }
};

const getImageBuffer = async (key) => {
  try {
    // Prüfen ob der Key bereits den MINIO_OWN_FOLDER enthält
    const fullKey = key.startsWith(MINIO_OWN_FOLDER)
      ? key
      : `${MINIO_OWN_FOLDER}/${key}`;

    const command = new GetObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: fullKey,
    });

    const response = await s3Client.send(command);
    const chunks = [];

    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }

    return { image: Buffer.concat(chunks) };
  } catch (err) {
    console.error("Error in getImageBuffer:", err);
    throw err;
  }
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

const handleCarData = async (carData, vin, positionIdentifier, res) => {
  try {
    // Prüfe zuerst den Cache
    const cacheKey = getCacheKey("image", vin, positionIdentifier, "original");
    const cached = await getFromCache(cacheKey);

    if (cached.hit) {
      console.log(`Cache hit for original image from ${cached.source}`);
      return { image: Buffer.from(cached.data, "base64") };
    }

    let image = null;
    if (!carData) {
      let hasLocalImage = await findFromOwnStore(vin);
      if (!hasLocalImage.found) {
        res.status(404).send();
        return;
      }
      let positionImage = hasLocalImage.images.find(
        (x) => x.positionIdentifier == positionIdentifier
      );
      if (!positionImage) {
        res.status(404).send();
        return;
      }
      image = await getImageBuffer(
        `${positionImage.vin}/${positionImage.fileName}`
      );
    } else {
      image = carData.images.find(
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
    }

    // Cache das Originalbild
    await setInCache(cacheKey, image.image.toString("base64"), CACHE_TTL.IMAGE);

    return image;
  } catch (err) {
    console.error("Error in handleCarData:", err);
    throw err;
  }
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

    try {
      const image = await handleCarData(carData, vin, positionIdentifier, res);
      res.set("Content-Type", "image/jpeg");
      let i = image.image;
      i = await postProcessImage(req, i);
      res.status(200).send(i);
    } catch (err) {
      console.error(err);
      res.status(404).send();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, found: false, error: err });
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

    try {
      const image = await handleCarData(carData, vin, positionIdentifier, res);
      res.set("Content-Type", "image/jpeg");
      let im = image.image;
      im = await postProcessImage(req, im);
      if (positionIdentifier == 1) im = await brandImage(im);
      res.status(200).send(im);
    } catch (err) {
      console.error(err);
      res.status(404).send();
    }
  } catch (err) {
    res.status(500).json({ success: false, found: false, error: err });
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
mongoose.connect(mongoUrl);

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

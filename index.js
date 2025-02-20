import express from "express";
import { createClient } from "@supabase/supabase-js";
import jimp from "jimp";
import cors from "cors";
import { BasicStrategy } from "passport-http";
import passport from "passport";
import Redis from "ioredis";
import * as dotenv from "dotenv";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import sharp from "sharp";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const port = process.env.SERVER_PORT;
const AUTHUSER = process.env.AUTHUSER;
const AUTHPASSWORD = process.env.AUTHPASSWORD;
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const BUCKET_NAME = process.env.BUCKET_NAME;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CACHE_TTL = 30 * 60;

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const basePathLocal = path.normalize("own");

let BRAND = null;

let BRANDS = {
  BRAND: null,
  BRANDDSG: null,
  BRANDAPPROVED: null,
  BRANDBOR: null,
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

// Cache-Funktionen
async function getFromCache(key) {
  try {
    const cachedData = await redis.getBuffer(key);
    if (cachedData) {
      console.log(`Cache HIT: ${key}`);
      return cachedData;
    }
    console.log(`Cache MISS: ${key}`);
    return null;
  } catch (error) {
    console.error("Redis error:", error);
    return null;
  }
}

async function setCache(key, data, ttl = CACHE_TTL) {
  try {
    await redis.set(key, data, "EX", ttl);
    return true;
  } catch (error) {
    console.error("Redis cache error:", error);
    return false;
  }
}

// Supabase Funktionen
async function getCarData(vin) {
  const { data, error } = await supabase
    .from("cars")
    .select("*")
    .eq("vin", vin)
    .single();

  if (error) {
    console.error("Supabase error:", error);
    return null;
  }

  return data;
}

async function getImageFromSupabase(path) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(path);

  if (error) {
    console.error("Supabase storage error:", error);
    return null;
  }

  // In Buffer umwandeln
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function getImageForCar(vin, positionIdentifier) {
  // Bildpfad in Supabase: "vin/positionIdentifier.jpg"
  const imagePath = `${vin}/${positionIdentifier}.jpg`;

  // Erstelle einen Cache-Key
  const cacheKey = `img:${vin}:${positionIdentifier}`;

  // Versuche zuerst aus dem Cache zu lesen
  const cachedImage = await getFromCache(cacheKey);
  if (cachedImage) {
    return { image: cachedImage };
  }

  // Versuche dann aus Supabase zu lesen
  const imageBuffer = await getImageFromSupabase(imagePath);
  if (imageBuffer) {
    // In Cache speichern
    await setCache(cacheKey, imageBuffer);
    return { image: imageBuffer };
  }

  // Fallback: Versuche lokalen Speicher
  return await findFromLocalStore(vin, positionIdentifier);
}

// Lokale Speicher Funktionen (als Fallback beibehalten)
const findFromLocalStore = async (vin, positionIdentifier) => {
  const fullPath = path.join(basePathLocal, vin);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  let files = fs.readdirSync(fullPath);
  let r = new RegExp(`^${vin}_${positionIdentifier}.\\w+$`);
  const matchingFile = files.find((x) => r.test(x));

  if (!matchingFile) {
    return null;
  }

  const filePath = path.join(fullPath, matchingFile);
  return {
    image: fs.readFileSync(filePath),
    local: true,
  };
};
// Bildverarbeitung
const postProcessImage = async (req, imageBuffer) => {
  try {
    let vin = req.params.vin;
    let positionIdentifier = req.params.positionIdentifier;
    let shrink = req.query.shrink;

    if (!shrink) {
      return imageBuffer;
    }

    // Cache-Key für verarbeitetes Bild
    const cacheKey = `img:${vin}:${positionIdentifier}:${shrink}`;

    // Versuche aus Cache zu laden
    const cachedImage = await getFromCache(cacheKey);
    if (cachedImage) {
      return cachedImage;
    }

    // Bild verarbeiten
    const processedImage = await sharp(imageBuffer)
      .resize(parseInt(shrink))
      .jpeg()
      .toBuffer();

    // In Cache speichern
    await setCache(cacheKey, processedImage);

    return processedImage;
  } catch (err) {
    console.error("Image processing error:", err);
    return imageBuffer;
  }
};

// let Image, Car;

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

// const getImageBuffer = (p) => {
//   const fullPath = path.join(basePathLocal, p);
//   return { image: fs.readFileSync(fullPath) };
// };

const brandImage = async (imageBuffer, brand = "BRAND") => {
  if (!BRANDS[brand]) return imageBuffer;

  try {
    const cacheKey = `brand:${brand}:${imageBuffer
      .toString("base64")
      .slice(0, 20)}`;

    // Versuche aus Cache zu laden
    const cachedImage = await getFromCache(cacheKey);
    if (cachedImage) {
      return cachedImage;
    }

    let imageTmp = await jimp.read(imageBuffer);
    imageTmp = await imageTmp.composite(
      BRANDS[brand],
      0,
      imageTmp.bitmap.height - BRANDS[brand].bitmap.height
    );

    const brandedImage = await imageTmp.getBufferAsync(jimp.MIME_JPEG);

    // In Cache speichern
    await setCache(cacheKey, brandedImage);

    return brandedImage;
  } catch (error) {
    console.error("Branding error:", error);
    return imageBuffer;
  }
};

// const handleCarData = (carData, vin, positionIdentifier, res) => {
//   return new Promise(async (resolve, reject) => {
//     let image = null;
//     if (!carData) {
//       let hasLocalImage = await findFromOwnStore(vin);
//       if (!hasLocalImage.found) {
//         res.status(404).send();
//         reject();
//         return;
//       }
//       let positionImage = hasLocalImage.images.find(
//         (x) => x.positionIdentifier == positionIdentifier
//       );
//       if (!positionImage) {
//         res.status(404).send();
//         reject();
//         return;
//       }
//       image = getImageBuffer(`${positionImage.vin}/${positionImage.fileName}`);
//     } else {
//       image = carData.images.find(
//         (x) => x.positionIdentifier == positionIdentifier
//       );
//       if (!image) {
//         res.status(404).send();
//         reject();
//         return;
//       }
//       let imageId = image.imageId;
//       image = await Image.findOne({ _id: imageId });
//       if (!image) {
//         res.status(404).send();
//         reject();
//         return;
//       }
//     }
//     resolve(image);
//   });
// };

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

    // Versuche zuerst aus dem Cache zu lesen
    const cacheKey = `status:${vin}`;
    const cachedStatus = await redis.get(cacheKey);
    if (cachedStatus) {
      return res.status(200).json(JSON.parse(cachedStatus));
    }

    // Hole Daten aus Supabase
    const carData = await getCarData(vin);

    if (!carData) {
      // Prüfe lokalen Speicher als Fallback
      const localImages = await findFromOwnStore(vin);
      if (!localImages.found) {
        const response = {
          success: true,
          found: false,
        };
        await redis.set(cacheKey, JSON.stringify(response), "EX", 300); // 5 Minuten cachen
        return res.status(200).json(response);
      }

      const response = {
        success: true,
        found: true,
        images: localImages.images.map(
          (x) => `/${vin}/${x.positionIdentifier}`
        ),
        photofairy: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await redis.set(cacheKey, JSON.stringify(response), "EX", 300);
      return res.status(200).json(response);
    }

    // Formatiere die Antwort
    const response = {
      success: true,
      found: true,
      images: carData.images
        .sort((a, b) => a.positionIdentifier - b.positionIdentifier)
        .map((x) => `/${vin}/${x.positionIdentifier}`),
      photofairy: !carData.linked,
      createdAt: carData.created_at,
      updatedAt: carData.updated_at,
    };

    // Cache die Antwort
    await redis.set(cacheKey, JSON.stringify(response), "EX", 300);

    return res.status(200).json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, found: false, error: err.message });
  }
});

app.get("/images/v1/raw/:vin/:positionIdentifier", async (req, res) => {
  try {
    const vin = req.params.vin;
    const positionIdentifier = req.params.positionIdentifier;

    if (!/^\w{17}$/g.test(vin)) {
      return res.status(400).json({
        success: false,
        found: false,
        error: `${vin} is not a valid VIN.`,
      });
    }

    // Cache Key für raw image
    const rawCacheKey = `raw:${vin}:${positionIdentifier}`;

    // Check ob ein prozessiertes Bild mit Query-Parameter angefordert wird
    const shrinkParam = req.query.shrink;
    const finalCacheKey = shrinkParam
      ? `${rawCacheKey}:${shrinkParam}`
      : rawCacheKey;

    // Versuche zuerst aus dem Cache zu lesen
    const cachedImage = await getFromCache(finalCacheKey);
    if (cachedImage) {
      res.set("Content-Type", "image/jpeg");
      return res.status(200).send(cachedImage);
    }

    // Hole das Bild
    const image = await getImageForCar(vin, positionIdentifier);

    if (!image) {
      return res.status(404).send();
    }

    // Wenn nötig, verarbeite das Bild
    const processedImage = await postProcessImage(req, image.image);

    // Speichere das verarbeitete Bild im Cache
    if (shrinkParam) {
      await setCache(finalCacheKey, processedImage);
    }

    res.set("Content-Type", "image/jpeg");
    return res.status(200).send(processedImage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, found: false, error: err.message });
  }
});
app.get("/images/v1/brand/:vin/:positionIdentifier", async (req, res) => {
  try {
    const vin = req.params.vin;
    const positionIdentifier = req.params.positionIdentifier;

    if (!/^\w{17}$/g.test(vin)) {
      return res.status(400).json({
        success: false,
        found: false,
        error: `${vin} is not a valid VIN.`,
      });
    }

    // Cache Key
    const cacheKey = `brand:${vin}:${positionIdentifier}`;

    // Versuche zuerst aus dem Cache zu lesen
    const cachedImage = await getFromCache(cacheKey);
    if (cachedImage) {
      res.set("Content-Type", "image/jpeg");
      return res.status(200).send(cachedImage);
    }

    // Hole das Bild
    const image = await getImageForCar(vin, positionIdentifier);

    if (!image) {
      return res.status(404).send();
    }

    // Füge Brand hinzu wenn nötig
    let finalImage = image.image;
    if (positionIdentifier == 1) {
      finalImage = await brandImage(finalImage);
    }

    // Cache das gebrandete Bild
    await setCache(cacheKey, finalImage);

    res.set("Content-Type", "image/jpeg");
    return res.status(200).send(finalImage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, found: false, error: err.message });
  }
});

app.get(
  /^\/images\/v2\/brand(?:\/(\w+))(?:\/(\w{17}))(?:\/(\d{1,2}))(\.jpg)??/,
  async (req, res) => {
    try {
      const brandId = req.params[0];
      const vin = req.params[1];
      const positionIdentifier = req.params[2];

      if (!Object.keys(BRANDS).includes(brandId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid brandId set",
        });
      }

      if (!/^\w{17}$/g.test(vin)) {
        return res.status(400).json({
          success: false,
          found: false,
          error: `${vin} is not a valid VIN.`,
        });
      }

      // Cache Key mit Brand ID
      const cacheKey = `brand:${brandId}:${vin}:${positionIdentifier}`;
      const shrinkParam = req.query.shrink;
      const finalCacheKey = shrinkParam
        ? `${cacheKey}:${shrinkParam}`
        : cacheKey;

      // Versuche zuerst aus dem Cache zu lesen
      const cachedImage = await getFromCache(finalCacheKey);
      if (cachedImage) {
        res.set("Content-Type", "image/jpeg");
        return res.status(200).send(cachedImage);
      }

      // Hole das Bild
      const image = await getImageForCar(vin, positionIdentifier);

      if (!image) {
        return res.status(404).send();
      }

      // Verarbeite das Bild wenn nötig
      let processedImage = await postProcessImage(req, image.image);

      // Füge Brand hinzu wenn nötig
      if (positionIdentifier == 1) {
        processedImage = await brandImage(processedImage, brandId);
      }

      // Cache das endgültige Bild
      await setCache(finalCacheKey, processedImage);

      res.set("Content-Type", "image/jpeg");
      return res.status(200).send(processedImage);
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ success: false, found: false, error: err.message });
    }
  }
);

app.get("/images/v1/status/changedsince/:seconds", async (req, res) => {
  try {
    const sec = req.params.seconds;
    const timestamp = new Date(Date.now() - sec * 1000).toISOString();

    // Cache key
    const cacheKey = `changedsince:${sec}`;

    // Versuche aus Cache zu lesen
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.status(200).json(JSON.parse(cachedData));
    }

    // Supabase Abfrage
    const { data, error } = await supabase
      .from("cars")
      .select("vin")
      .gte("updated_at", timestamp);

    if (error) throw error;

    const result = {
      success: true,
      data: data.map((item) => item.vin),
    };

    // Cache für 60 Sekunden
    await redis.set(cacheKey, JSON.stringify(result), "EX", 60);

    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/images/v1/link/:from/:to", async (req, res) => {
  try {
    const from = req.params.from;
    const to = req.params.to;

    for (let x of [from, to]) {
      if (!/^\w{17}$/g.test(x)) {
        return res.status(400).json({
          success: false,
          found: false,
          error: `${x} is not a valid VIN.`,
        });
      }
    }

    // Prüfe, ob Ziel-VIN bereits existiert
    const existingCar = await getCarData(to);
    if (existingCar) {
      throw `VIN ${to} already exists in database.`;
    }

    // Hole Quelldaten
    const sourceCar = await getCarData(from);
    if (!sourceCar) {
      return res.status(404).json({
        success: false,
        error: `Car to link from not found.`,
      });
    }

    // Erstelle neues Car in Supabase
    const { data, error } = await supabase.from("cars").insert({
      vin: to,
      images: sourceCar.images,
      linked: true,
    });

    if (error) throw error;

    // Lösche relevante Cache-Einträge
    await redis.del(`status:${to}`);

    res.status(200).json({ success: true, query: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/images/v1/link/:vin", async (req, res) => {
  const vin = req.params.vin;

  if (!/^\w{17}$/g.test(vin)) {
    return res.status(400).json({
      success: false,
      found: false,
      error: `${vin} is not a valid VIN.`,
    });
  }

  try {
    // Hole Car-Daten
    const carData = await getCarData(vin);

    if (!carData) {
      return res.status(404).json({
        success: false,
        error: `No cardata found for ${vin}`,
      });
    }

    if (!carData.linked) {
      return res.status(400).json({
        success: false,
        error: `${vin} contains original pictures and cannot be deleted.`,
      });
    }

    // Lösche aus Supabase
    const { data, error } = await supabase.from("cars").delete().eq("vin", vin);

    if (error) throw error;

    // Lösche Cache-Einträge
    await redis.del(`status:${vin}`);

    res.status(200).json({ success: true, deletedData: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete(
  "/images/v1/original/:vin",
  passport.authenticate("basic", { session: false }),
  async (req, res) => {
    const vin = req.params.vin;

    if (!/^\w{17}$/g.test(vin)) {
      return res.status(400).json({
        success: false,
        found: false,
        error: `${vin} is not a valid VIN.`,
      });
    }

    try {
      // Prüfe ob Auto existiert
      const carData = await getCarData(vin);

      if (!carData) {
        return res.status(404).json({
          success: false,
          error: `No cardata found for ${vin}`,
        });
      }

      // Lösche aus Supabase
      const { data, error } = await supabase
        .from("cars")
        .delete()
        .eq("vin", vin);

      if (error) throw error;

      // Bei Originalbild auch die Bilder aus dem Storage löschen
      if (!carData.linked) {
        for (const img of carData.images) {
          const { error: storageError } = await supabase.storage
            .from(BUCKET_NAME)
            .remove([`${vin}/${img.positionIdentifier}.jpg`]);

          if (storageError)
            console.error("Storage deletion error:", storageError);
        }
      }

      // Lösche alle relevanten Cache-Einträge
      const keys = await redis.keys(`*${vin}*`);
      if (keys.length > 0) {
        await redis.del(keys);
      }

      res.status(200).json({ success: true, deletedData: data });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Starte den Server und lade Brands
app.listen(port, async () => {
  try {
    // Lade Branding-Bilder
    BRAND = await jimp.read(`./Header_Petrol.png`);
    BRANDS = {
      BRAND: await jimp.read(`./Header_Petrol.png`),
      BRANDDSG: await jimp.read(`./Header_Petrol.png`),
      BRANDAPPROVED: await jimp.read(`./Header_Petrol.png`),
      BRANDBOR: await jimp.read(`./Header_Petrol.png`),
    };

    console.log(`App listening on port ${port}`);
    console.log(`Connected to Redis @ ${REDIS_HOST}:${REDIS_PORT}`);
    console.log(`Connected to Supabase @ ${SUPABASE_URL}`);
  } catch (error) {
    console.error("Error loading branding images:", error);
    process.exit(1);
  }
});

// Fehlerbehandlung für Redis
redis.on("error", (err) => {
  console.error("Redis connection error:", err);
  // Nicht beenden, da wir Fallbacks haben
});

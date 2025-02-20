import express from "express";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import { BasicStrategy } from "passport-http";
import passport from "passport";
import Redis from "ioredis";
import * as dotenv from "dotenv";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import sharp from "sharp";

/**
 * Lade Umgebungsvariablen aus .env wenn nicht in Produktion
 */
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// Konfigurationskonstanten
const port = process.env.SERVER_PORT;
const AUTHUSER = process.env.AUTHUSER;
const AUTHPASSWORD = process.env.AUTHPASSWORD;
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const BUCKET_NAME = process.env.BUCKET_NAME;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CACHE_TTL = 30 * 60; // 30 Minuten in Sekunden

// Service-Clients initialisieren
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Lokaler Speicherpfad für Fallback-Bilder
const basePathLocal = path.normalize("own");

/**
 * Branding-Konfiguration
 * Verschiedene Branding-Varianten, die beim Start geladen werden
 */
let BRANDS = {
  BRAND: null,
  BRANDDSG: null,
  BRANDAPPROVED: null,
  BRANDBOR: null,
};

/**
 * Basic Auth Konfiguration
 * Wird für geschützte Endpunkte verwendet
 */
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

/**
 * Cache-Funktionen
 */

/**
 * Liest Daten aus dem Redis-Cache
 * @param {string} key - Cache-Schlüssel
 * @returns {Promise<Buffer|null>} Cached data oder null wenn nicht gefunden
 */
async function getFromCache(key) {
  try {
    const cachedData = await redis.getBuffer(key);
    if (cachedData) {
      console.log(`[Cache] Hit: ${key}`);
      return cachedData;
    }
    console.log(`[Cache] Miss: ${key}`);
    return null;
  } catch (error) {
    console.error(`[Cache] Error reading key ${key}:`, error.message);
    return null;
  }
}

/**
 * Speichert Daten im Redis-Cache
 * @param {string} key - Cache-Schlüssel
 * @param {Buffer} data - Zu cachende Daten
 * @param {number} ttl - Time-to-live in Sekunden
 * @returns {Promise<boolean>} Erfolg der Operation
 */
async function setCache(key, data, ttl = CACHE_TTL) {
  try {
    await redis.set(key, data, "EX", ttl);
    console.log(`[Cache] Set: ${key} (TTL: ${ttl}s)`);
    return true;
  } catch (error) {
    console.error(`[Cache] Error setting key ${key}:`, error.message);
    return false;
  }
}

/**
 * Supabase Funktionen
 */

/**
 * Holt Fahrzeugdaten aus der Datenbank
 * @param {string} vin - Fahrzeug-Identifikationsnummer
 * @returns {Promise<Object|null>} Fahrzeugdaten oder null
 */
async function getCarData(vin) {
  const { data, error } = await supabase
    .from("cars")
    .select("*")
    .eq("vin", vin)
    .single();

  if (error) {
    console.error(`[DB] Error fetching car data for ${vin}:`, error.message);
    return null;
  }

  return data;
}

/**
 * Lädt ein Bild aus dem Supabase Storage
 * @param {string} path - Pfad zum Bild im Storage
 * @returns {Promise<Buffer|null>} Bilddaten oder null
 */
async function getImageFromSupabase(path) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(path);

  if (error) {
    console.error(`[Storage] Error downloading ${path}:`, error.message);
    return null;
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Hauptfunktion zum Laden von Fahrzeugbildern
 * Versucht nacheinander: Cache -> Supabase -> Lokaler Speicher
 * @param {string} vin - Fahrzeug-Identifikationsnummer
 * @param {number} positionIdentifier - Bildposition
 * @returns {Promise<Object|null>} Bilddaten und Metadaten
 */
async function getImageForCar(vin, positionIdentifier) {
  const imagePath = `${vin}/${positionIdentifier}.jpg`;
  const cacheKey = `img:${vin}:${positionIdentifier}`;

  // 1. Cache-Versuch
  const cachedImage = await getFromCache(cacheKey);
  if (cachedImage) {
    return { image: cachedImage };
  }

  // 2. Supabase-Versuch
  const imageBuffer = await getImageFromSupabase(imagePath);
  if (imageBuffer) {
    await setCache(cacheKey, imageBuffer);
    return { image: imageBuffer };
  }

  // 3. Lokaler Fallback
  return await findFromLocalStore(vin, positionIdentifier);
}

/**
 * Sucht ein Bild im lokalen Speicher
 * @param {string} vin - Fahrzeug-Identifikationsnummer
 * @param {number} positionIdentifier - Bildposition
 * @returns {Promise<Object|null>} Bilddaten und Metadaten
 */
const findFromLocalStore = async (vin, positionIdentifier) => {
  const fullPath = path.join(basePathLocal, vin);
  if (!fs.existsSync(fullPath)) {
    console.log(`[Local] Directory not found: ${fullPath}`);
    return null;
  }

  let files = fs.readdirSync(fullPath);
  let r = new RegExp(`^${vin}_${positionIdentifier}.\\w+$`);
  const matchingFile = files.find((x) => r.test(x));

  if (!matchingFile) {
    console.log(`[Local] No matching file for ${vin}/${positionIdentifier}`);
    return null;
  }

  const filePath = path.join(fullPath, matchingFile);
  console.log(`[Local] Found file: ${filePath}`);
  return {
    image: fs.readFileSync(filePath),
    local: true,
  };
};

/**
 * Verarbeitet ein Bild (Resize)
 * @param {Object} req - Express Request Object
 * @param {Buffer} imageBuffer - Originalbild
 * @returns {Promise<Buffer>} Verarbeitetes Bild
 */
const postProcessImage = async (req, imageBuffer) => {
  try {
    let shrink = req.query.shrink;

    if (!shrink) {
      return imageBuffer;
    }

    const width = parseInt(shrink, 10);
    if (isNaN(width) || width <= 0) {
      console.error(`[Image] Invalid shrink parameter: ${shrink}`);
      return imageBuffer;
    }

    console.log(`[Image] Processing image, target width: ${width}px`);
    const processedImage = await sharp(imageBuffer)
      .resize(width, null, {
        withoutEnlargement: true,
        fit: "inside",
      })
      .jpeg({
        quality: 80,
        progressive: true,
      })
      .toBuffer();

    return processedImage;
  } catch (err) {
    console.error(`[Image] Processing error:`, err.message);
    return imageBuffer;
  }
};

/**
 * Sucht alle Bilder für eine VIN im lokalen Speicher
 * @param {string} vin - Fahrzeug-Identifikationsnummer
 * @returns {Promise<Object>} Gefundene Bilder und Metadaten
 */
const findFromOwnStore = (vin) => {
  return new Promise((resolve, reject) => {
    let found = false;
    let images = [];
    const fullPath = path.join(basePathLocal, vin);

    if (!fs.existsSync(fullPath)) {
      console.log(`[Local] No directory for VIN ${vin}`);
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
    console.log(`[Local] Found ${files.length} images for VIN ${vin}`);
    resolve({
      found,
      images: files,
      local: true,
    });
  });
};

/**
 * Fügt Branding zu einem Bild hinzu
 * @param {Buffer} imageBuffer - Originalbild
 * @param {string} brand - Branding-Variante
 * @returns {Promise<Buffer>} Bild mit Branding
 */
const brandImage = async (imageBuffer, brand = "BRAND") => {
  if (!BRANDS[brand]) {
    console.log(`[Brand] No branding asset for ${brand}, skipping`);
    return imageBuffer;
  }

  try {
    const cacheKey = `brand:${brand}:${imageBuffer
      .toString("base64")
      .slice(0, 20)}`;

    const cachedImage = await getFromCache(cacheKey);
    if (cachedImage) {
      return cachedImage;
    }

    console.log(`[Brand] Applying ${brand} branding`);
    const processedImage = await sharp(imageBuffer)
      .composite([
        {
          input: BRANDS[brand],
          gravity: "south",
        },
      ])
      .jpeg()
      .toBuffer();

    await setCache(cacheKey, processedImage);
    return processedImage;
  } catch (error) {
    console.error(`[Brand] Error applying ${brand}:`, error.message);
    return imageBuffer;
  }
};

// Server-Initialisierung
const app = express();

// Middleware
app.use(
  morgan((tokens, req, res) => {
    return [
      `[HTTP]`,
      tokens.method(req, res),
      tokens.url(req, res),
      tokens.status(req, res),
      `${tokens["response-time"](req, res)}ms`,
    ].join(" ");
  })
);
app.use(cors());

// Basis-Healthcheck
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

      // Cache Key für finales Bild (inkl. Branding und Shrink)
      const shrinkParam = req.query.shrink;
      const finalCacheKey = shrinkParam
        ? `brand:${brandId}:${vin}:${positionIdentifier}:${shrinkParam}`
        : `brand:${brandId}:${vin}:${positionIdentifier}`;

      // Versuche zuerst aus dem Cache zu laden
      const cachedImage = await getFromCache(finalCacheKey);
      if (cachedImage) {
        res.set("Content-Type", "image/jpeg");
        return res.status(200).send(cachedImage);
      }

      // Hole das Originalbild
      const originalCacheKey = `img:${vin}:${positionIdentifier}`;
      let image = await getFromCache(originalCacheKey);

      if (!image) {
        const imageResult = await getImageForCar(vin, positionIdentifier);
        if (!imageResult) {
          return res.status(404).send();
        }
        image = imageResult.image;
        // Cache das Originalbild
        await setCache(originalCacheKey, image);
      }

      // Verarbeite das Bild wenn nötig
      let processedImage = await postProcessImage(req, image);

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

    // Erstelle Timestamp für den Vergleich
    const compareDate = new Date(Date.now() - sec * 1000);

    // Cache key
    const cacheKey = `changedsince:${sec}`;

    // Versuche aus Cache zu lesen
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.status(200).json(JSON.parse(cachedData));
    }

    // Supabase Abfrage für beide Zeitstempel
    const { data: createdData, error: createdError } = await supabase
      .from("cars")
      .select("vin, created_at")
      .gt("created_at", compareDate.toISOString());

    const { data: updatedData, error: updatedError } = await supabase
      .from("cars")
      .select("vin, updated_at")
      .gt("updated_at", compareDate.toISOString());

    if (createdError || updatedError) throw createdError || updatedError;

    // Kombiniere und dedupliziere die VINs
    const allVins = [
      ...new Set([
        ...(createdData || []).map((item) => item.vin),
        ...(updatedData || []).map((item) => item.vin),
      ]),
    ];

    const result = {
      success: true,
      data: allVins,
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

/**
 * Server Startup
 * Lädt Branding-Assets und startet den Server
 */
app.listen(port, async () => {
  try {
    // Lade Branding-Bilder
    console.log("[Init] Loading branding assets...");
    const brandBuffer = await sharp("./Header_Petrol.png").toBuffer();
    BRANDS = {
      BRAND: brandBuffer,
      BRANDDSG: brandBuffer,
      BRANDAPPROVED: brandBuffer,
      BRANDBOR: brandBuffer,
    };

    console.log(`[Server] Listening on port ${port}`);
    console.log(`[Redis] Connected to ${REDIS_HOST}:${REDIS_PORT}`);
    console.log(`[Supabase] Connected to ${SUPABASE_URL}`);
  } catch (error) {
    console.error("[Init] Failed to load branding assets:", error.message);
    process.exit(1);
  }
});

// Redis Fehlerbehandlung
redis.on("error", (err) => {
  console.error("[Redis] Connection error:", err.message);
});

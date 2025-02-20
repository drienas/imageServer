import mongoose from "mongoose";
import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";
import sharp from "sharp";
import express from "express";
import * as dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// Konfiguration
const MONGO_URL = process.env.MONGO_URL || "mongodb://jobrouter6:27017/cardata";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const BUCKET_NAME = "car-images";
const BATCH_SIZE = 50; // Anzahl der Dokumente pro Batch

// Clients initialisieren
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
});

// MongoDB Schemas
const imageSchema = new mongoose.Schema(
  {
    image: { type: Buffer },
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

// Hilfsfunktionen
async function connectToMongo() {
  try {
    await mongoose.connect(MONGO_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("MongoDB connected");
    return {
      Image: mongoose.model("Image", imageSchema),
      Car: mongoose.model("Car", carSchema),
    };
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}

// Lookup-Tabelle für ObjectId zu Pfad/VIN Zuordnung
const idToPathMap = new Map();

// Migriere ein einzelnes Auto mit seinen Bildern
async function migrateCar(car, Image) {
  try {
    console.log(`Prüfe Migration für Auto ${car.vin}...`);

    // Prüfe, ob das Auto bereits in Supabase existiert
    const { data: existingCar, error: queryError } = await supabase
      .from("cars")
      .select("*")
      .eq("vin", car.vin)
      .single();

    if (queryError && queryError.code !== "PGRST116") {
      console.error(`Error checking existing car ${car.vin}:`, queryError);
      return false;
    }

    // Wenn das Auto bereits existiert, vergleiche die Zeitstempel
    if (existingCar) {
      const mongoTimestamp = car.updatedAt || car.createdAt;
      const supabaseTimestamp = new Date(
        existingCar.updated_at || existingCar.created_at
      );

      // Auch wenn wir das Auto überspringen, müssen wir die idToPathMap für verlinkte Autos befüllen
      if (mongoTimestamp <= supabaseTimestamp) {
        console.log(
          `Überspringe ${
            car.vin
          }: Supabase-Daten sind aktueller oder gleich alt (Mongo: ${mongoTimestamp.toISOString()}, Supabase: ${supabaseTimestamp.toISOString()})`
        );

        // Befülle die idToPathMap mit den existierenden Bildern
        for (const imgEntry of car.images) {
          const existingImage = existingCar.images.find(
            (img) => img.positionIdentifier === imgEntry.positionIdentifier
          );
          if (existingImage) {
            idToPathMap.set(imgEntry.imageId.toString(), {
              path: existingImage.path,
              vin: car.vin,
              positionIdentifier: imgEntry.positionIdentifier,
            });
            console.log(
              `Mapping für verlinktes Bild ${imgEntry.imageId} aus existierendem Auto ${car.vin} erstellt`
            );
          }
        }

        return true; // Migration "erfolgreich", da keine Aktion notwendig
      }
      console.log(
        `Aktualisiere ${
          car.vin
        }: MongoDB-Daten sind neuer (Mongo: ${mongoTimestamp.toISOString()}, Supabase: ${supabaseTimestamp.toISOString()})`
      );
    } else {
      console.log(`Migriere neues Auto ${car.vin}`);
    }

    // Bilder sammeln und hochladen
    const imageEntries = [];
    for (const imgEntry of car.images) {
      try {
        const imageDoc = await Image.findById(imgEntry.imageId);
        if (!imageDoc) {
          console.warn(`Bild nicht gefunden für ID ${imgEntry.imageId}`);
          continue;
        }

        // Optimiere das Bild vor dem Upload
        const optimizedImage = await sharp(imageDoc.image)
          .jpeg({ quality: 85, progressive: true })
          .toBuffer();

        // Pfad für das Bild in Supabase
        const imagePath = `${car.vin}/${imgEntry.positionIdentifier}.jpg`;

        // Upload zu Supabase
        const { error: uploadError } = await supabase.storage
          .from(BUCKET_NAME)
          .upload(imagePath, optimizedImage, {
            contentType: "image/jpeg",
            upsert: true,
          });

        if (uploadError) {
          console.error(`Upload fehlgeschlagen für ${car.vin}:`, uploadError);
          continue;
        }

        // Speichere die ID und Pfad für spätere Verknüpfungen
        idToPathMap.set(imgEntry.imageId.toString(), {
          path: imagePath,
          vin: car.vin,
          positionIdentifier: imgEntry.positionIdentifier,
        });

        imageEntries.push({
          positionIdentifier: imgEntry.positionIdentifier,
          path: imagePath,
          originalId: imgEntry.imageId.toString(),
        });
      } catch (err) {
        console.error(
          `Fehler bei der Bildverarbeitung ${imgEntry.imageId}:`,
          err
        );
      }
    }

    if (existingCar) {
      // Auto existiert bereits, aktualisiere die Bilder
      let images = existingCar.images || [];

      // Aktualisiere oder füge neue Bilder hinzu
      for (const newImage of imageEntries) {
        const existingIndex = images.findIndex(
          (img) => img.positionIdentifier === newImage.positionIdentifier
        );

        if (existingIndex !== -1) {
          images[existingIndex] = newImage;
        } else {
          images.push(newImage);
        }
      }

      // Aktualisiere den Datensatz
      const { error } = await supabase
        .from("cars")
        .update({
          images: images,
          linked: !!car.linked,
          updated_at: new Date().toISOString(),
        })
        .eq("vin", car.vin);

      if (error) {
        console.error(`Aktualisierung fehlgeschlagen für ${car.vin}:`, error);
        return false;
      }
    } else {
      // Erstelle neuen Eintrag
      const { error } = await supabase.from("cars").insert({
        vin: car.vin,
        images: imageEntries,
        linked: !!car.linked,
        created_at: car.createdAt?.toISOString(),
        updated_at: new Date().toISOString(),
      });

      if (error) {
        console.error(`Einfügen fehlgeschlagen für ${car.vin}:`, error);
        return false;
      }
    }

    // Lösche relevante Cache-Einträge
    await redis.del(`status:${car.vin}`);
    const changedSinceCacheKeys = await redis.keys("changedsince:*");
    if (changedSinceCacheKeys.length > 0) {
      await redis.del(changedSinceCacheKeys);
    }

    console.log(
      `Migration erfolgreich für ${car.vin} mit ${imageEntries.length} Bildern`
    );
    return true;
  } catch (error) {
    console.error(`Fehler bei der Migration von ${car.vin}:`, error);
    return false;
  }
}

// Verknüpfte Autos migrieren
async function migrateLinkedCars(Car) {
  try {
    console.log("Prüfe verlinkte Autos...");
    const linkedCars = await Car.find({ linked: true });
    console.log(`${linkedCars.length} verlinkte Autos gefunden`);

    let successCount = 0;

    for (const linkedCar of linkedCars) {
      try {
        // Prüfe zuerst, ob das Auto bereits in Supabase existiert
        const { data: existingCar, error: queryError } = await supabase
          .from("cars")
          .select("*")
          .eq("vin", linkedCar.vin)
          .single();

        if (queryError && queryError.code !== "PGRST116") {
          console.error(
            `Fehler beim Prüfen des verlinkten Autos ${linkedCar.vin}:`,
            queryError
          );
          continue;
        }

        // Wenn das Auto existiert, vergleiche die Zeitstempel
        if (existingCar) {
          // Setze Fallback-Zeitstempel für MongoDB, falls keine vorhanden sind
          const mongoTimestamp =
            linkedCar.updatedAt || linkedCar.createdAt || new Date(0);
          const supabaseTimestamp = new Date(
            existingCar.updated_at || existingCar.created_at || new Date(0)
          );

          if (mongoTimestamp <= supabaseTimestamp) {
            console.log(
              `Überspringe verlinktes Auto ${
                linkedCar.vin
              }: Supabase-Daten sind aktueller oder gleich alt (Mongo: ${mongoTimestamp.toISOString()}, Supabase: ${supabaseTimestamp.toISOString()})`
            );
            successCount++; // Zählt als Erfolg, da keine Aktion notwendig
            continue;
          }
          console.log(
            `Aktualisiere verlinktes Auto ${
              linkedCar.vin
            }: MongoDB-Daten sind neuer (Mongo: ${mongoTimestamp.toISOString()}, Supabase: ${supabaseTimestamp.toISOString()})`
          );
        } else {
          console.log(`Migriere neues verlinktes Auto ${linkedCar.vin}`);
        }

        // Umwandlung der ObjectIds in Supabase-Pfade
        const imageEntries = [];
        for (const imgEntry of linkedCar.images) {
          const originalIdStr = imgEntry.imageId.toString();
          const mappedImage = idToPathMap.get(originalIdStr);

          if (mappedImage) {
            imageEntries.push({
              positionIdentifier: imgEntry.positionIdentifier,
              path: mappedImage.path,
              originalId: originalIdStr,
            });
          } else {
            console.warn(
              `Mapping nicht gefunden für verlinktes Bild ${originalIdStr} in Auto ${linkedCar.vin}`
            );
          }
        }

        if (imageEntries.length === 0) {
          console.warn(
            `Keine Bilder konnten für das verlinkte Auto ${linkedCar.vin} gemappt werden`
          );
          continue;
        }

        // In Supabase einfügen oder aktualisieren
        const { error } = await supabase.from("cars").upsert({
          vin: linkedCar.vin,
          images: imageEntries,
          linked: true,
          created_at: linkedCar.createdAt
            ? linkedCar.createdAt.toISOString()
            : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        if (error) {
          console.error(
            `Fehler beim Speichern des verlinkten Autos ${linkedCar.vin}:`,
            error
          );
          continue;
        }

        // Cache-Einträge löschen
        await redis.del(`status:${linkedCar.vin}`);
        const changedSinceCacheKeys = await redis.keys("changedsince:*");
        if (changedSinceCacheKeys.length > 0) {
          await redis.del(changedSinceCacheKeys);
        }

        console.log(
          `Verlinktes Auto ${linkedCar.vin} erfolgreich migriert mit ${imageEntries.length} Bildern`
        );
        successCount++;
      } catch (err) {
        console.error(
          `Fehler bei der Verarbeitung des verlinkten Autos ${linkedCar.vin}:`,
          err
        );
      }
    }

    console.log(
      `Migration der verlinkten Autos abgeschlossen. Erfolg: ${successCount}/${linkedCars.length}`
    );
  } catch (error) {
    console.error("Fehler bei der Migration der verlinkten Autos:", error);
  }
}

// Migrations-Hauptfunktion
async function runMigration() {
  try {
    console.log("Starting migration process...");

    // Verbindung zu MongoDB herstellen
    const { Image, Car } = await connectToMongo();

    // Gesamtzahl der Autos ermitteln
    const totalCars = await Car.countDocuments({ linked: { $ne: true } });
    console.log(`Found ${totalCars} original cars to migrate`);

    // Batch-weise migrieren
    let processedCount = 0;
    let successCount = 0;
    let currentBatch = 0;

    while (processedCount < totalCars) {
      // Sortiere nach updatedAt und createdAt absteigend (neueste zuerst)
      const cars = await Car.find({ linked: { $ne: true } })
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(currentBatch * BATCH_SIZE)
        .limit(BATCH_SIZE);

      if (cars.length === 0) break;

      console.log(
        `Processing batch ${currentBatch + 1} with ${cars.length} cars`
      );

      for (const car of cars) {
        const success = await migrateCar(car, Image);
        if (success) successCount++;
        processedCount++;

        if (processedCount % 10 === 0) {
          console.log(
            `Progress: ${processedCount}/${totalCars} (${Math.round(
              (processedCount / totalCars) * 100
            )}%)`
          );
        }
      }

      currentBatch++;
    }

    console.log(
      `Completed original cars migration. Success: ${successCount}/${totalCars}`
    );

    // Migriere verlinkte Autos, auch hier nach Zeitstempel sortiert
    console.log("Prüfe verlinkte Autos...");
    const linkedCars = await Car.find({ linked: true }).sort({
      updatedAt: -1,
      createdAt: -1,
    });
    console.log(`${linkedCars.length} verlinkte Autos gefunden`);

    await migrateLinkedCars(Car);

    console.log("Migration complete");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    // Verbindungen schließen
    await mongoose.connection.close();
    redis.disconnect();
    console.log("Connections closed");
  }
}

// ----- FALLBACK SERVICE -----

// Fallback-Service, der Bilder aus MongoDB holt, wenn sie in Supabase nicht gefunden werden
async function startFallbackService() {
  const app = express();
  const { Image, Car } = await connectToMongo();

  // Hilfsfunktion für Metadaten-Update
  async function updateCarMetadata(
    vin,
    positionIdentifier,
    imagePath,
    car,
    imageBuffer
  ) {
    try {
      // Prüfe, ob das Auto bereits existiert
      const { data: existingCar, error: queryError } = await supabase
        .from("cars")
        .select("*")
        .eq("vin", vin)
        .single();

      if (queryError && queryError.code !== "PGRST116") {
        throw queryError;
      }

      // Wenn das Auto verlinkt ist, finde das Original-Auto
      let originalCar = null;
      if (car.linked) {
        // Suche das Original-Auto in MongoDB
        const linkedImageEntry = car.images.find(
          (img) => img.positionIdentifier === parseInt(positionIdentifier)
        );
        if (linkedImageEntry) {
          // Finde das Original-Auto anhand der Bild-ID
          originalCar = await Car.findOne({
            "images.imageId": linkedImageEntry.imageId,
            linked: { $ne: true },
          });
        }
      }

      // Wenn es ein verlinktes Auto ist und wir das Original gefunden haben
      if (car.linked && originalCar) {
        const originalImagePath = `${originalCar.vin}/${positionIdentifier}.jpg`;

        // Prüfe ob das Original-Bild bereits in Supabase existiert
        const { data: originalExists } = await supabase.storage
          .from(BUCKET_NAME)
          .list(originalCar.vin, {
            search: `${positionIdentifier}.jpg`,
          });

        if (!originalExists || originalExists.length === 0) {
          console.log(
            `Original image for linked car ${vin} not found in Supabase, uploading...`
          );
          // Upload des Original-Bildes
          const { error: uploadError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(originalImagePath, imageBuffer, {
              contentType: "image/jpeg",
              upsert: true,
            });

          if (uploadError) {
            throw new Error(
              `Failed to upload original image: ${uploadError.message}`
            );
          }
          console.log(
            `Successfully uploaded original image to ${originalImagePath}`
          );

          // Lösche den Status-Cache des Original-Autos
          await redis.del(`status:${originalCar.vin}`);
        }

        // Aktualisiere den Pfad auf das Original-Bild
        imagePath = originalImagePath;
      }

      if (!existingCar) {
        // Erstelle neuen Eintrag
        const { error } = await supabase.from("cars").insert({
          vin: vin,
          images: [
            {
              positionIdentifier: parseInt(positionIdentifier),
              path: imagePath,
            },
          ],
          linked: !!car.linked,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        if (error) throw error;
        console.log(
          `Created new metadata entry for ${vin} (linked: ${!!car.linked})`
        );

        // Lösche den Status-Cache für das neue Auto
        await redis.del(`status:${vin}`);
      } else {
        // Auto existiert bereits, aktualisiere die Bilder
        let images = existingCar.images || [];
        const existingImageIndex = images.findIndex(
          (img) => img.positionIdentifier === parseInt(positionIdentifier)
        );

        if (existingImageIndex !== -1) {
          // Ersetze vorhandenes Bild
          images[existingImageIndex] = {
            positionIdentifier: parseInt(positionIdentifier),
            path: imagePath,
          };
        } else {
          // Füge neues Bild hinzu
          images.push({
            positionIdentifier: parseInt(positionIdentifier),
            path: imagePath,
          });
        }

        // Aktualisiere den Datensatz
        const { error } = await supabase
          .from("cars")
          .update({
            images: images,
            linked: !!car.linked,
            updated_at: new Date().toISOString(),
          })
          .eq("vin", vin);

        if (error) throw error;
        console.log(`Updated metadata for ${vin} (linked: ${!!car.linked})`);

        // Lösche den Status-Cache für das aktualisierte Auto
        await redis.del(`status:${vin}`);
      }

      // Lösche auch alle changedsince Caches, da sich Metadaten geändert haben
      const changedSinceCacheKeys = await redis.keys("changedsince:*");
      if (changedSinceCacheKeys.length > 0) {
        await redis.del(changedSinceCacheKeys);
        console.log("Cleared changedsince caches");
      }
    } catch (error) {
      console.error("Metadata update error:", error);
      throw error;
    }
  }

  app.get("/fallback/:vin/:positionIdentifier", async (req, res) => {
    try {
      const { vin, positionIdentifier } = req.params;

      // Cache-Schlüssel
      const cacheKey = `fallback:${vin}:${positionIdentifier}`;

      // Versuche aus dem Cache zu laden
      const cachedImage = await redis.getBuffer(cacheKey);
      if (cachedImage) {
        res.set("Content-Type", "image/jpeg");
        res.set("X-Source", "fallback-cache");
        return res.send(cachedImage);
      }

      // Hole Auto aus MongoDB
      const car = await Car.findOne({ vin });
      if (!car) {
        return res.status(404).json({ error: "Car not found" });
      }

      // Finde das entsprechende Bild
      const imageEntry = car.images.find(
        (img) => img.positionIdentifier === parseInt(positionIdentifier)
      );

      if (!imageEntry) {
        return res.status(404).json({ error: "Image not found for this car" });
      }

      // Hole das Bild
      const image = await Image.findById(imageEntry.imageId);
      if (!image) {
        return res.status(404).json({ error: "Image data not found" });
      }

      // Speichere im Cache
      await redis.set(cacheKey, image.image, "EX", 3600); // 1 Stunde Cache

      // Versuche das Bild zu migrieren und Metadaten zu aktualisieren
      try {
        const optimizedImage = await sharp(image.image)
          .jpeg({ quality: 85, progressive: true })
          .toBuffer();

        let imagePath = `${vin}/${positionIdentifier}.jpg`;

        // Bei verlinkten Autos nur die Metadaten aktualisieren
        if (!car.linked) {
          // Upload zu Supabase Storage nur für nicht-verlinkte Autos
          const { error: uploadError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(imagePath, optimizedImage, {
              contentType: "image/jpeg",
              upsert: true,
            });

          if (uploadError) {
            throw uploadError;
          }
        }

        // Aktualisiere die Metadaten und stelle sicher, dass Original-Bilder existieren
        await updateCarMetadata(
          vin,
          positionIdentifier,
          imagePath,
          car,
          optimizedImage
        );

        console.log(
          `Auto-migrated ${
            car.linked ? "linked" : ""
          } image and metadata for ${vin}/${positionIdentifier} during fallback`
        );
      } catch (err) {
        console.error("Auto-migration failed:", err);
      }

      // Sende das Bild
      res.set("Content-Type", "image/jpeg");
      res.set("X-Source", "mongodb-fallback");
      res.send(image.image);
    } catch (error) {
      console.error("Fallback error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const PORT = process.env.FALLBACK_PORT || 3334;
  app.listen(PORT, () => {
    console.log(`Fallback service running on port ${PORT}`);
  });
}

// Hauptausführung
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const command = process.argv[2];

  if (command === "migrate") {
    runMigration()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("Migration failed:", err);
        process.exit(1);
      });
  } else if (command === "fallback") {
    startFallbackService().catch((err) => {
      console.error("Failed to start fallback service:", err);
      process.exit(1);
    });
  } else if (command === "all") {
    runMigration()
      .then(() => startFallbackService())
      .catch((err) => {
        console.error("Error:", err);
        process.exit(1);
      });
  } else {
    console.log(`
Usage:
  node migration.js migrate   - Run migration only
  node migration.js fallback  - Start fallback service only
  node migration.js all      - Run migration and start fallback service
`);
    process.exit(1);
  }
}

export { runMigration, startFallbackService };

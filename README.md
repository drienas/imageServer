# Image Server

Ein hochperformanter Bildserver mit integriertem Caching-System, Bildverarbeitung, verschiedenen Branding-Optionen und automatischer Migration von Legacy-Daten.

## Architektur

Das System besteht aus zwei Hauptkomponenten:

1. **Image Server (index.js)**

   - Hauptserver für Bildauslieferung
   - Caching und Bildverarbeitung
   - Branding-Funktionalität
   - Mehrschichtige Bildsuche (Cache -> Supabase -> Fallback -> Lokal)

2. **Fallback/Migration Server (migrate.js)**
   - Automatische Migration von MongoDB zu Supabase
   - Fallback-Bildauslieferung
   - On-Demand Migration bei Bildanfragen
   - Verarbeitung verlinkter Fahrzeuge

## Konfiguration

### Umgebungsvariablen

```env
# Server-Konfiguration
SERVER_PORT=3334                    # Port für den Hauptserver
FALLBACK_SERVER=localhost          # Hostname des Fallback-Servers
FALLBACK_PORT=3335                # Port des Fallback-Servers
FALLBACK_ENABLED=true             # Aktivierung des Fallback-Mechanismus

# Authentifizierung
AUTHUSER=admin                    # Basic Auth Benutzername
AUTHPASSWORD=xxx                  # Basic Auth Passwort

# Supabase Konfiguration
SUPABASE_URL=xxx                  # Supabase URL
SUPABASE_KEY=xxx                  # Supabase API Key
BUCKET_NAME=car-images            # Supabase Storage Bucket

# Redis Konfiguration
REDIS_HOST=xxx                    # Redis Host
REDIS_PORT=6379                   # Redis Port
REDIS_PASSWORD=xxx                # Redis Passwort

# MongoDB (nur für Fallback/Migration)
MONGO_URL=mongodb://localhost:27017/cardata  # MongoDB Connection String
```

## Containerisierung

Das System ist in zwei separate Docker-Container aufgeteilt:

### Image Server Container

```dockerfile
# Dockerfile für den Hauptserver
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3334
CMD ["node", "index.js"]
```

### Fallback Server Container

```dockerfile
# Dockerfile für den Fallback/Migration Server
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3335
CMD ["node", "migrate.js", "fallback"]
```

## Endpunkte

### Status-Endpunkte

#### `GET /images/v1/status/:vin`

Liefert Informationen über verfügbare Bilder für ein Fahrzeug.

**Parameter:**

- `vin`: 17-stellige Fahrzeug-Identifikationsnummer

**Beispiel-Antwort:**

```json
{
  "success": true,
  "found": true,
  "images": [
    "/VF1RFB00270131313/1",
    "/VF1RFB00270131313/2",
    "/VF1RFB00270131313/3"
  ],
  "photofairy": false,
  "createdAt": "2024-02-20T10:00:00.000Z",
  "updatedAt": "2024-02-20T10:00:00.000Z"
}
```

#### `GET /images/v1/status/changedsince/:seconds`

Liefert eine Liste von VINs, die in den letzten X Sekunden erstellt oder aktualisiert wurden.

**Parameter:**

- `seconds`: Zeitraum in Sekunden

**Rückgabe:**

- Kombinierte und deduplizierte Liste aller VINs, die entweder neu erstellt oder aktualisiert wurden
- Prüft sowohl `created_at` als auch `updated_at` Zeitstempel
- Cache-Dauer: 60 Sekunden

**Beispiel:**

```
GET /images/v1/status/changedsince/3600  // Änderungen der letzten Stunde

Antwort:
{
  "success": true,
  "data": ["VF1RFB00270131313", "WDD1234567890123"]
}
```

### Bild-Endpunkte

#### `GET /images/v1/raw/:vin/:positionIdentifier`

Liefert das Originalbild ohne Branding.

**Parameter:**

- `vin`: 17-stellige VIN
- `positionIdentifier`: Bildposition (1-n)
- `shrink` (optional): Zielbreite in Pixeln

**Beispiel:**

```
GET /images/v1/raw/VF1RFB00270131313/1?shrink=800
```

#### `GET /images/v1/brand/:vin/:positionIdentifier`

Liefert das Bild mit Standard-Branding.

**Parameter:**

- Wie bei raw-Endpunkt
- Branding wird automatisch auf Position 1 angewendet

#### `GET /images/v2/brand/:brandId/:vin/:positionIdentifier`

Liefert das Bild mit spezifischem Branding.

**Parameter:**

- `brandId`: BRAND, BRANDDSG, BRANDAPPROVED, BRANDBOR
- Weitere Parameter wie bei raw-Endpunkt

**Beispiel:**

```
GET /images/v2/brand/BRANDDSG/VF1RFB00270131313/1?shrink=400
```

### Verwaltungs-Endpunkte

#### `GET /images/v1/link/:from/:to`

Verknüpft Bilder von einer VIN mit einer anderen.

**Parameter:**

- `from`: Quell-VIN
- `to`: Ziel-VIN

#### `DELETE /images/v1/link/:vin`

Löscht eine Bildverknüpfung (nur verlinkte Bilder).

#### `DELETE /images/v1/original/:vin`

Löscht Originalbilder (Basic Auth erforderlich).

## Caching-Mechanismus

Der Server verwendet einen mehrstufigen Cache:

1. **Originalbild-Cache**

   - Key-Format: `img:${vin}:${positionIdentifier}`
   - TTL: 30 Minuten
   - Wird beim ersten Abruf befüllt

2. **Verarbeitete-Bild-Cache**

   - Key-Format: `brand:${brandId}:${vin}:${positionIdentifier}:${shrink}`
   - Speichert bereits verarbeitete Versionen (Größenänderung + Branding)
   - Verhindert wiederholte Bildverarbeitung

3. **Status-Cache**
   - Key-Format: `status:${vin}` für Bildstatus
   - Key-Format: `changedsince:${seconds}` für Änderungsabfragen
   - Kurze TTL für Änderungsabfragen (60 Sekunden)

Cache-Invalidierung:

- Automatische Invalidierung durch TTL
- Manuelle Invalidierung bei Löschoperationen
- Pattern-basierte Invalidierung (z.B. alle Einträge einer VIN)

## Datenstruktur

### Supabase Tabellen

#### Cars

```sql
CREATE TABLE cars (
  vin TEXT PRIMARY KEY,
  images JSONB,
  linked BOOLEAN,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
);
```

#### Images-Array-Struktur

```json
{
  "positionIdentifier": 1,
  "fileName": "VIN_1.jpg"
}
```

### Dateispeicher

#### Supabase Storage

- Bucket-Struktur: `${vin}/${positionIdentifier}.jpg`
- Originaldateien werden im JPEG-Format gespeichert

#### Lokaler Fallback-Speicher

- Verzeichnisstruktur: `own/${vin}/`
- Dateinamen-Format: `${vin}_${positionIdentifier}.jpg`

### Branding-Assets

- Vorgeladene Buffer für verschiedene Branding-Varianten
- Werden beim Serverstart geladen
- Gleiche Basis-Datei mit unterschiedlichen Verwendungszwecken

## Migration und Fallback-Mechanismus

### Automatische Migration

Der Fallback-Server bietet zwei Betriebsmodi:

1. **Vollständige Migration**

   ```bash
   node migrate.js migrate
   ```

   - Migriert alle Fahrzeuge und Bilder von MongoDB zu Supabase
   - Berücksichtigt verlinkte Fahrzeuge
   - Erstellt korrekte Metadaten

2. **Fallback-Service**
   ```bash
   node migrate.js fallback
   ```
   - Stellt Bilder aus MongoDB bereit
   - Führt On-Demand Migration durch
   - Aktualisiert Metadaten automatisch

### Verlinkte Fahrzeuge

Der Server unterstützt zwei Arten von Fahrzeugen:

1. **Original-Fahrzeuge**

   - Speichern ihre eigenen Bilder
   - Werden als Quelle für verlinkte Fahrzeuge verwendet

2. **Verlinkte Fahrzeuge**
   - Verweisen auf Bilder von Original-Fahrzeugen
   - Speichern keine eigenen Bilder
   - Werden bei der Migration korrekt verknüpft

### Migrations-Prozess

1. **Bildverarbeitung**

   - JPEG-Optimierung (Qualität: 85)
   - Progressive JPEG-Format
   - Automatische Größenanpassung (optional)

2. **Metadaten-Verwaltung**

   - Erstellung/Aktualisierung von Supabase-Einträgen
   - Korrekte Zeitstempel-Verwaltung
   - Verknüpfungslogik für linked cars

3. **Cache-Invalidierung**
   - Automatische Löschung relevanter Cache-Einträge
   - Berücksichtigung von Status-Caches
   - Invalidierung von changedsince-Caches

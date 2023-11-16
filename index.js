import { backOff } from "exponential-backoff";
import fs from "fs";
import winston from "winston";
import Cache from "file-system-cache";

const cache = Cache({
  basePath: "cache",
  ns: "photos",
  ttl: 60 * 60 * 24 * 7, // 1 week
});

// Setting up Winston for logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    // log to console too
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

/**
 *
 * @param {*} url string
 * @returns {Promise<Response>} response
 */
async function retryFetch(url) {
  const response = await backOff(() => fetch(url), {
    numOfAttempts: 10,
    retry(e, attemptNum) {
      logger.error(
        `Attempt ${attemptNum} failed because of "${e.message}". Retrying...`
      );

      logger.error(e);
      return true;
    },
  });
  return response;
}

async function fetchAlbums() {
  const cachedAlbums = await cache.get("albums");
  if (cachedAlbums) {
    logger.info("Already fetched albums");
    return cachedAlbums;
  }

  const albumsResponse = await retryFetch(
    "https://jsonplaceholder.typicode.com/albums"
  );

  const albums = await albumsResponse.json();
  await cache.set("albums", albums);
  return albums;
}

/**
 *
 * @param {string} albumId
 */
async function fetchAlbumPhotos(albumId) {
  const cachedPhotos = await cache.get(`photos-${albumId}`);
  if (cachedPhotos) {
    logger.info(`Already fetched photos for album ${albumId}`);
    return cachedPhotos;
  }

  const photosResponse = await retryFetch(
    `https://jsonplaceholder.typicode.com/albums/${albumId}/photos`
  );

  const photos = await photosResponse.json();
  await cache.set(`photos-${albumId}`, photos);
  return photos;
}

/**
 *
 * @param {{ url: string; id: string}} photo
 * @param {string} albumFolderName
 */
async function downloadPhoto(photo, albumFolderName) {
  const cachedPhoto = await cache.get(`photo-${photo.id}`);
  if (cachedPhoto) {
    logger.info(
      `Already downloaded ${photo.id}.jpg from album "${albumFolderName}"`
    );
    return cachedPhoto;
  }

  logger.info(`Downloading ${photo.url} from album "${albumFolderName}"`);

  const photoResponse = await retryFetch(photo.url);
  const buffer = await photoResponse.arrayBuffer();
  fs.writeFile(
    `photos/${albumFolderName}/${photo.id}.jpg`,
    Buffer.from(buffer),
    () => {
      logger.info(`Downloaded ${photo.id}.jpg from album "${albumFolderName}"`);
      cache.set(`photo-${photo.id}`, photo);
    }
  );
}

async function run() {
  // fetch all albums on https://jsonplaceholder.typicode.com/albums
  const albums = await fetchAlbums();

  if (!fs.existsSync(`photos`)) {
    fs.mkdirSync(`photos`);
  }

  // loop through the albums and fetch the photos for each album
  for (const album of albums) {
    const photos = await fetchAlbumPhotos(album.id);

    // create a new folder for the album if it doesn't exist
    const albumFolderName = album.title.split(" ").join("-");
    if (!fs.existsSync(`photos/${albumFolderName}`)) {
      logger.info(`Creating folder ${albumFolderName}`);
      fs.mkdirSync(`photos/${albumFolderName}`);
    }

    // loop through the photos and download them
    for (const photo of photos.slice(0, 5)) {
      await downloadPhoto(photo, albumFolderName);
      // wait 3 seconds before fetching the next photo
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // wait 3 seconds before fetching the next album
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

run()
  .then(() => {
    logger.info("done");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

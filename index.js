import { Browser, FormData } from "happy-dom";
import ical from "ical-generator";
import fs from "node:fs";
import slugify from "slugify";

const CACHE_DIR = "cache"

function Semaphore(value) {
  let running = 0;
  const pending = [];
  async function tick() {
    console.debug(`running: ${running}/${value}; pending: ${pending.length}`);

    if (running >= value || pending.length === 0)
      return;

    const { fn, accept, reject } = pending.shift();
    running += 1
    try {
      accept(await fn());
    } catch( error ) {
      reject(error);
    } finally {
      running -= 1;
      tick();
    }
  }
  return function semaphore(fn) {
    return new Promise((accept, reject) => {
      pending.push({ fn, accept, reject });
      tick();
    })
  }
}

function read(path) {
  return new Promise((accept, reject) => {
    fs.readFile(path, (err, data) => {
      err ? reject(err) : accept(data);
    });
  });
}

function write(path, data) {
  return new Promise((accept, reject) => {
    fs.writeFile(path, data, (err) => {
      err ? reject(err) : accept();
    });
  });
}

async function cached(key, fn) {
  const path = `${CACHE_DIR}/${key}.json`;
  try {
    return JSON.parse(await read(path));
  } catch (err) {
    // if fn() throws, it should bubble up
    const value = await fn();
    try {
      await write(path, JSON.stringify(value));
    } catch (err) {
      // cache write error is not throwing
      console.error(`Could not write cache: ${err}`);
    }
    return value;
  }
}

async function fetchCinemas(window, token) {
  const body = new FormData();
  body.append("_token", token);
  const response = await window.fetch(
    "https://www.picturehouses.com/ajax-cinema-list",
    {
      method: "POST",
      body,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );

  if (!response.ok)
    throw new Error({
      status: response.status,
      text: await response.text(),
    });

  const json = await response.json();
  return new Map(
    json["cinema_list"].map((x) => [
      x["cinema_id"],
      {
        id: x["cinema_id"],
        name: json["cinemaloc"][x["cinema_id"]],
        slug: x["slug"].replace("-picturehouse", ""),
      },
    ]),
  );
}

async function fetchFilm(browser, filmUrl) {
  console.debug(`Fetching film ${filmUrl}`);
  const page = browser.newPage();
  try {
    await page.goto(filmUrl);
    await page.waitUntilComplete();
    return page.mainFrame.document.querySelector(
      "section .synopsisDiv",
    ).innerText.trim();
  } catch (error) {
    throw new Error(`Error fetching ${filmUrl}: ${error}`);
  } finally {
    await page.close();
  }
}

async function fetchShows(window, token, cinemaId) {
  const body = new FormData();
  // body.append("_token", token);
  body.append("cinema_id", cinemaId);
  const response = await window.fetch(
    "https://www.picturehouses.com/api/scheduled-movies-ajax",
    {
      method: "POST",
      body,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );

  if (!response.ok)
    throw new Error(`${response.status}: ${await response.text()}`);

  const shows = [];

  const json = await response.json();

  // (for debugging!)
  // await write("_shows.json", JSON.stringify(json, null, "\t"));

  for (const movie of json["movies"]) {
    for (const show of movie["show_times"]) {
      const title = movie["Title"];
      const soldOut = !!show["SoldoutStatus"];
      const start = new Date(show["Showtime"]);
      const end = new Date(start + 2 * 3600_000);
      const url = `https://web.picturehouses.com/order/showtimes/${show["CinemaId"]}-${show["SessionId"]}/seats`;
      const filmUrl = `https://www.picturehouses.com/movie-details/${show["CinemaId"]}/${movie["ScheduledFilmId"]}/${slugify(movie["Title"])}`;
      const filmId = movie["ScheduledFilmId"];
      const showId = show["SessionId"];
      const cinemaId = show["CinemaId"];
      const screenName = show["ScreenName"];
      const attributes = show["attributes"].map(
        (attribute) => attribute["attribute_full"],
      );
      shows.push({
        title,
        start,
        end,
        url,
        soldOut,
        filmUrl,
        filmId,
        showId,
        cinemaId,
        attributes,
      });
    }
  }
  return shows;
}

async function main() {
  const browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableComputedStyleRendering: true,
      navigation: {
        disableChildPageNavigation: true,
        disableChildFrameNavigation: true,
      },
    },
  });

  const page = browser.newPage();
  await page.goto("https://www.picturehouses.com/");
  await page.waitUntilComplete();

  const token =
    page.mainFrame.document.querySelector("input[name=_token]").value;
  const cinemas = await fetchCinemas(page.mainFrame.window, token);
  const shows = await fetchShows(page.mainFrame.window, token, "");
  const films = new Map(shows.map(({ filmId, filmUrl }) => [filmId, filmUrl]));
  // descriptions for all films (using filmId as key to filter out duplicates
  // from multiple shows per film). Using semaphore to control concurrency.
  const withSemaphore = Semaphore(8);
  const descriptions = new Map(
    await Promise.all(
      Array.from(films, async ([filmId, filmUrl]) => {
        try {
          return [
            filmId,
            await cached(filmId, async () => {
              return await withSemaphore(async () => {
                return await fetchFilm(browser, filmUrl)
              })
            })
          ];
        } catch (err) {
          return [filmId, "[no description]"];
        }
      })
    )
  );

  await write("_shows", JSON.stringify(shows, null, "\t"));

  // Calendar feed per cinema
  const feeds = new Map(
    Array.from(cinemas, ([cinemaId, { name }]) => [cinemaId, ical({ name })]),
  );

  shows.forEach(
    ({
      title,
      start,
      end,
      url,
      soldOut,
      filmUrl,
      filmId,
      showId,
      cinemaId,
      attributes,
      screenName,
    }) => {
      feeds.get(cinemaId).createEvent({
        start,
        end,
        url,
        summary: title,
        location: {
          title: cinemas.get(cinemaId).name,
        },
        description: [
          ...(soldOut ? ["[sold out]"] : []),
          screenName,
          filmUrl,
          descriptions.get(filmId),
          attributes.join("\n"),
        ].join("\n\n")
      });
    },
  );

  const dest = process.argv[2] || ".";

  await Promise.all(Array.from(feeds, async ([cinemaId, feed]) => {
    const slug = cinemas.get(cinemaId).slug;
    const name = `${dest}/${slug}.ics`;
    try {
      await write(name, feed.toString())
      console.log(`${name}: ${feed.length()} shows`);
    } catch (err) {
      console.error(`${name}: ${err}`);
    }
  }));

  await browser.close();
}

main();

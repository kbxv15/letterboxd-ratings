# Letterboxd Ratings on Hover

Hover any film title or poster on letterboxd.com (home, lists, diary, reviews, search, film pages, and so on) to see a card with:

- **Plot**: collapsed to a one-line preview by default. Click it to read the full synopsis from Letterboxd.
- **Cast**: collapsed to the first few names. Click it to see the top 25 actors and their characters (each links to the actor's Letterboxd page), plus a link to the full cast.
- **Letterboxd** average rating (out of 5) and rating count
- **IMDb** rating (out of 10) and vote count
- **Rotten Tomatoes** Tomatometer and Popcornmeter
- **IMDb parents guide**: the MPA rating and reason, plus a None / Mild / Moderate / Severe rating for Sex & Nudity, Violence & Gore, Profanity, Alcohol & Drugs, and Frightening scenes. Click a category to see its vote count and the non-spoiler notes. Spoiler notes, and any notes past the first 10, link out to IMDb.

Click any rating row to open that site's page for the film.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Reload any open Letterboxd tabs.

## Where the numbers come from

| Source | How |
|---|---|
| Letterboxd | The film's own Letterboxd page (same-site request), which also gives the IMDb ID, title and year |
| IMDb | The IMDb title page, fetched by your browser. If IMDb refuses the request, it uses OMDb instead (needs a key, see below) |
| Parents guide | The IMDb parents guide page (`/parentalguide/`), fetched by your browser. There's no OMDb fallback for this |
| Rotten Tomatoes | The IMDb ID is matched to the RT page through Wikidata. If there's no match, it searches RT by title and year. OMDb is the last fallback (Tomatometer only) |

Results are cached for 3 days (Letterboxd for 1 day). "Not found" results are cached for 6 hours.

## Settings (toolbar icon)

- **OMDb API key**: optional, free from <https://www.omdbapi.com/apikey.aspx>. Add one if the IMDb row says "Unavailable".
- **Show IMDb parents guide**: on by default. Turn it off to skip the extra IMDb request.
- **Hover delay**: 350 ms by default.
- **Clear cached ratings**

## Files

- `content.js` / `content.css`: finds film links on hover, fetches the Letterboxd data and draws the card
- `background.js`: IMDb and Rotten Tomatoes lookups, plus caching
- `options.html` / `options.js`: settings popup

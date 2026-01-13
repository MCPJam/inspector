"""
Fetch current first-team squads for select clubs and export to CSV.

Usage:
    pip install requests beautifulsoup4
    python scripts/fetch_squads.py
"""

from __future__ import annotations

import csv
import json
import re
import time
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/129.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

MIN_PLAYER_THRESHOLD = 10

CLUBS = [
    {
        "team": "FC Barcelona",
        "league": "LaLiga",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_FC_Barcelona_season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_FC_Barcelona_season",
        ],
    },
    {
        "team": "Real Madrid",
        "league": "LaLiga",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Real_Madrid_CF_season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Real_Madrid_CF_season",
        ],
    },
    {
        "team": "Atletico Madrid",
        "league": "LaLiga",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Atl%C3%A9tico_Madrid_season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Atl%C3%A9tico_Madrid_season",
        ],
    },
    {
        "team": "Manchester City",
        "league": "Premier League",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Manchester_City_F.C._season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Manchester_City_F.C._season",
        ],
    },
    {
        "team": "Manchester United",
        "league": "Premier League",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Manchester_United_F.C._season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Manchester_United_F.C._season",
        ],
    },
    {
        "team": "Chelsea",
        "league": "Premier League",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Chelsea_F.C._season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Chelsea_F.C._season",
        ],
    },
    {
        "team": "Liverpool",
        "league": "Premier League",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Liverpool_F.C._season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Liverpool_F.C._season",
        ],
    },
    {
        "team": "Arsenal",
        "league": "Premier League",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Arsenal_F.C._season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Arsenal_F.C._season",
        ],
    },
    {
        "team": "Tottenham Hotspur",
        "league": "Premier League",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_Tottenham_Hotspur_F.C._season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_Tottenham_Hotspur_F.C._season",
        ],
    },
    {
        "team": "Bayern Munich",
        "league": "Bayern",
        "urls": [
            "https://en.wikipedia.org/wiki/2025%E2%80%9326_FC_Bayern_Munich_season",
            "https://en.wikipedia.org/wiki/2024%E2%80%9325_FC_Bayern_Munich_season",
        ],
    },
]


def fetch_soup(url: str) -> BeautifulSoup | None:
    """Download a page and return BeautifulSoup, or None on failure."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:  # noqa: BLE001
        print(f"  ! Failed to fetch {url}: {exc}")
        return None


def has_flagicon(table) -> bool:
    return bool(table.select("span.flagicon"))


def is_player_table(table, require_country: bool = False) -> bool:
    """Determine whether a wikitable likely represents a first-team squad."""

    header_cells = table.find_all("th")
    headers = [th.get_text(" ", strip=True).lower() for th in header_cells]
    if not headers:
        return False

    has_player = any("player" in h or h == "name" for h in headers)
    has_position = any("pos" in h or "position" in h for h in headers)
    has_country = any(
        term in h
        for h in headers
        for term in ("nation", "nat", "nat.", "country", "nationality")
    )

    has_number = any(h.startswith("no") or h == "n" or "squad number" in h for h in headers)

    if require_country:
        return has_player and has_position and has_country

    return has_player and has_position and (
        has_country or (has_flagicon(table) and has_number)
    )


def find_first_team_table(soup: BeautifulSoup):
    """
    Find the first-team squad table on a typical season page.

    Strategy:
    - Look for a heading (h2/h3) whose span id or text contains "First-team squad"
    - Take the next table with class "wikitable" after that heading that contains
      the typical squad columns (player/name, position, nationality)
    - If not found, scan all wikitables until one matches
    """

    fallback_near_heading = None

    for span in soup.find_all("span", class_="mw-headline"):
        text = (span.get_text(strip=True) or "").lower()
        if "first-team squad" in text or "first team squad" in text:
            heading = span.parent  # usually h2 or h3
            sib = heading
            while sib is not None:
                sib = sib.find_next_sibling()
                if sib is None:
                    break
                if sib.name == "table" and "wikitable" in sib.get("class", []):
                    if is_player_table(sib, require_country=True):
                        return sib
                    if fallback_near_heading is None and is_player_table(sib):
                        fallback_near_heading = sib

    if fallback_near_heading is not None:
        return fallback_near_heading

    for table in soup.find_all("table", class_="wikitable"):
        if is_player_table(table, require_country=True):
            return table

    for table in soup.find_all("table", class_="wikitable"):
        if is_player_table(table):
            return table

    table = soup.find("table", class_="wikitable")
    if table:
        print("  ! Using fallback: first wikitable on page (check this club manually).")
    return table


def extract_country_from_cell(cell) -> str:
    if not cell:
        return ""
    flag = cell.find("span", class_="flagicon")
    if flag:
        img = flag.find("img")
        if img and img.get("alt"):
            return img["alt"].strip()
        link = flag.find("a")
        if link:
            return link.get_text(strip=True)
    return ""


def parse_first_team_table(table, team: str, league: str):
    """Parse a wikitable into rows of (Name, Country, Position, Shirt Number)."""

    rows: list[dict[str, Any]] = []
    if table is None:
        return rows

    header_row = table.find("tr")
    if not header_row:
        return rows

    headers = [th.get_text(" ", strip=True).lower() for th in header_row.find_all("th")]
    col_player = col_pos = col_nat = col_number = None

    for idx, header in enumerate(headers):
        if "player" in header or header == "name":
            col_player = idx
        elif "pos" in header or "position" in header:
            col_pos = idx
        elif "nation" in header or "nat" in header or "country" in header:
            col_nat = idx
        elif "no" in header or header == "n" or "squad number" in header or "number" in header:
            col_number = idx

    # If no explicit number column, check if first column is numbers
    if col_number is None and headers:
        first_header = headers[0].strip()
        # Check if first column might be numbers (common pattern)
        first_cells = [tr.find_all(["td", "th"])[0] for tr in table.find_all("tr")[1:6] if tr.find_all(["td", "th"])]
        if first_cells:
            first_cell_text = first_cells[0].get_text(strip=True)
            if first_cell_text.isdigit() or first_cell_text == "":
                col_number = 0
                # Adjust other columns if number is first
                if col_player is not None:
                    col_player += 1
                if col_pos is not None:
                    col_pos += 1
                if col_nat is not None:
                    col_nat += 1

    for tr in table.find_all("tr")[1:]:
        cells = tr.find_all(["td", "th"])
        if not cells or len(cells) < 2:
            continue

        def get_cell(idx):
            if idx is None or idx >= len(cells):
                return ""
            return cells[idx]

        player_cell = get_cell(col_player)
        if player_cell:
            link = player_cell.find("a")
            name = link.get_text(strip=True) if link else player_cell.get_text(" ", strip=True)
        else:
            name = ""

        pos_cell = get_cell(col_pos)
        position = pos_cell.get_text(" ", strip=True) if pos_cell else ""

        nat_cell = get_cell(col_nat)
        country = ""
        if nat_cell:
            links = nat_cell.find_all("a")
            if links:
                country = links[-1].get_text(strip=True)
            else:
                country = nat_cell.get_text(" ", strip=True)
        else:
            country = extract_country_from_cell(player_cell)

        number_cell = get_cell(col_number)
        shirt_number = ""
        if number_cell:
            shirt_number = number_cell.get_text(" ", strip=True)
            # Clean up number (remove non-digits, but keep if it's a range like "12-15")
            if shirt_number and not shirt_number.replace("-", "").replace("/", "").isdigit():
                # Try to extract just the number
                numbers = re.findall(r'\d+', shirt_number)
                if numbers:
                    shirt_number = numbers[0]
                else:
                    shirt_number = ""

        if not name:
            continue
        
        # Normalize country codes
        if country:
            country_map = {
                "Spain": "ESP", "Spanish": "ESP",
                "Netherlands": "NED", "Dutch": "NED",
                "England": "ENG", "English": "ENG",
                "France": "FRA", "French": "FRA",
                "Germany": "GER", "German": "GER",
                "Brazil": "BRA", "Brazilian": "BRA",
                "Argentina": "ARG", "Argentine": "ARG",
                "Portugal": "POR", "Portuguese": "POR",
                "Italy": "ITA", "Italian": "ITA",
                "Belgium": "BEL", "Belgian": "BEL",
                "Uruguay": "URU", "Uruguayan": "URU",
                "Colombia": "COL", "Colombian": "COL",
                "Sweden": "SWE", "Swedish": "SWE",
                "Norway": "NOR", "Norwegian": "NOR",
                "Denmark": "DEN", "Danish": "DEN",
                "Poland": "POL", "Polish": "POL",
                "Croatia": "CRO", "Croatian": "CRO",
                "Serbia": "SRB", "Serbian": "SRB",
                "Ghana": "GHA", "Ghanaian": "GHA",
                "Senegal": "SEN", "Senegalese": "SEN",
                "Egypt": "EGY", "Egyptian": "EGY",
                "Japan": "JPN", "Japanese": "JPN",
                "South Korea": "KOR", "Korean": "KOR",
                "Australia": "AUS", "Australian": "AUS",
                "Canada": "CAN", "Canadian": "CAN",
                "United States": "USA", "American": "USA", "USA": "USA",
                "Mexico": "MEX", "Mexican": "MEX",
                "Hungary": "HUN", "Hungarian": "HUN",
                "Romania": "ROU", "Romanian": "ROU",
                "Austria": "AUT", "Austrian": "AUT",
                "Switzerland": "SUI", "Swiss": "SUI",
                "Wales": "WAL", "Welsh": "WAL",
                "Scotland": "SCO", "Scottish": "SCO",
                "Northern Ireland": "NIR", "Northern Irish": "NIR",
                "Republic of Ireland": "IRL", "Irish": "IRL",
                "Georgia": "GEO", "Georgian": "GEO",
                "Mali": "MLI", "Malian": "MLI",
                "Ivory Coast": "CIV", "Ivorian": "CIV",
                "Algeria": "ALG", "Algerian": "ALG",
                "Uzbekistan": "UZB", "Uzbek": "UZB",
                "Czech Republic": "CZE", "Czech": "CZE",
                "Israel": "ISR", "Israeli": "ISR",
                "Ecuador": "ECU", "Ecuadorian": "ECU",
            }
            country = country_map.get(country, country.upper() if len(country) <= 3 else country)

        rows.append(
            {
                "Name": name,
                "Team": team,
                "Country": country,
                "Position": position,
                "League": league,
                "Shirt Number": shirt_number,
            }
        )

    return rows


def fetch_club_squad(club_cfg):
    """Try all URLs for a club until we successfully parse a first-team table."""

    team = club_cfg["team"]
    league = club_cfg["league"]
    urls = club_cfg["urls"]
    partial_rows: list[dict[str, Any]] = []

    for url in urls:
        print(f"\nFetching {team} from: {url}")
        soup = fetch_soup(url)
        if soup is None:
            continue

        table = find_first_team_table(soup)
        if table is None:
            print("  ! No squad table found on this page.")
            continue

        rows = parse_first_team_table(table, team, league)
        if rows:
            print(f"  -> Found {len(rows)} players for {team}.")
            if len(rows) >= MIN_PLAYER_THRESHOLD:
                return rows
            partial_rows = rows
            print("  ! Roster looks incomplete, trying fallback URL...")
        else:
            print("  ! Table parsed but produced 0 players. Trying next URL...")

    if partial_rows:
        print(
            f"!! Using partial roster for {team} ({len(partial_rows)} players). "
            "Consider updating the source URL."
        )
        return partial_rows

    print(f"!! Failed to get squad for {team}.")
    return []


def search_player_info(name: str, team: str) -> tuple[str, str]:
    """
    Search for player nationality and shirt number using web search.
    Returns (country, shirt_number) tuple.
    """
    # Known data for famous players (2025-2026 season)
    # Format: "Player Name": ("Country Code", "Shirt Number")
    known_players = {
        # Tottenham Hotspur
        "Pedro Porro": ("ESP", "23"),
        "Xavi Simons": ("NED", "10"),
        "Guglielmo Vicario": ("ITA", "13"),
        "Cristian Romero": ("ARG", "17"),
        "Destiny Udogie": ("ITA", "38"),
        "Yves Bissouma": ("MLI", "8"),
        "James Maddison": ("ENG", "10"),
        "Dejan Kulusevski": ("SWE", "21"),
        "Richarlison": ("BRA", "9"),
        "Dominic Solanke": ("ENG", "9"),
        "Mohammed Kudus": ("GHA", "11"),
        "Brennan Johnson": ("WAL", "22"),
        "Micky van de Ven": ("NED", "37"),
        "João Palhinha": ("POR", "6"),
        "Radu Drăgușin": ("ROU", "6"),
        "Kevin Danso": ("AUT", "15"),
        "Ben Davies": ("WAL", "33"),
        "Archie Gray": ("ENG", "44"),
        "Lucas Bergvall": ("SWE", "41"),
        "Pape Matar Sarr": ("SEN", "29"),
        "Rodrigo Bentancur": ("URU", "30"),
        "Mathys Tel": ("FRA", "18"),
        "Randal Kolo Muani": ("FRA", "9"),
        "Wilson Odobert": ("FRA", "23"),
        # FC Barcelona
        "Marc-André ter Stegen": ("GER", "1"),
        "Joan García": ("ESP", "13"),
        "Alejandro Balde": ("ESP", "3"),
        "Ronald Araújo": ("URU", "4"),
        "Pau Cubarsí": ("ESP", "5"),
        "Andreas Christensen": ("DEN", "15"),
        "Jules Koundé": ("FRA", "23"),
        "Gavi": ("ESP", "6"),
        "Pedri": ("ESP", "8"),
        "Frenkie de Jong": ("NED", "21"),
        "Ferran Torres": ("ESP", "7"),
        "Robert Lewandowski": ("POL", "9"),
        "Lamine Yamal": ("ESP", "10"),
        "Raphinha": ("BRA", "11"),
        "Marcus Rashford": ("ENG", "14"),
        "Roony Bardghji": ("SWE", "28"),
        # Real Madrid
        "Thibaut Courtois": ("BEL", "1"),
        "Dani Carvajal": ("ESP", "2"),
        "Éder Militão": ("BRA", "3"),
        "David Alaba": ("AUT", "4"),
        "Jude Bellingham": ("ENG", "5"),
        "Eduardo Camavinga": ("FRA", "12"),
        "Vinícius Júnior": ("BRA", "7"),
        "Federico Valverde": ("URU", "15"),
        "Endrick": ("BRA", "9"),
        "Kylian Mbappé": ("FRA", "10"),
        "Rodrygo": ("BRA", "11"),
        "Trent Alexander-Arnold": ("ENG", "12"),
        "Andriy Lunin": ("UKR", "13"),
        # Manchester City
        "James Trafford": ("ENG", "1"),
        "Stefan Ortega": ("GER", "18"),
        "Gianluigi Donnarumma": ("ITA", "25"),
        "Rúben Dias": ("POR", "3"),
        "John Stones": ("ENG", "5"),
        "Nathan Aké": ("NED", "6"),
        "Joško Gvardiol": ("CRO", "24"),
        "Rodri": ("ESP", "16"),
        "Bernardo Silva": ("POR", "20"),
        "Phil Foden": ("ENG", "47"),
        "Erling Haaland": ("NOR", "9"),
        # Liverpool
        "Alisson Becker": ("BRA", "1"),
        "Virgil van Dijk": ("NED", "4"),
        "Ibrahima Konaté": ("FRA", "5"),
        "Wataru Endo": ("JPN", "3"),
        "Alexis Mac Allister": ("ARG", "10"),
        "Mohamed Salah": ("EGY", "11"),
        "Florian Wirtz": ("GER", "7"),
        "Dominik Szoboszlai": ("HUN", "8"),
        "Alexander Isak": ("SWE", "14"),
        "Federico Chiesa": ("ITA", "7"),
        "Cody Gakpo": ("NED", "18"),
        "Andy Robertson": ("SCO", "26"),
        "Conor Bradley": ("NIR", "12"),
        # Chelsea
        "Robert Sánchez": ("ESP", "1"),
        "Marc Cucurella": ("ESP", "3"),
        "Reece James": ("ENG", "24"),
        "Enzo Fernández": ("ARG", "8"),
        "Cole Palmer": ("ENG", "20"),
        "Moisés Caicedo": ("ECU", "25"),
        "Mykhailo Mudryk": ("UKR", "10"),
        # Bayern Munich
        "Manuel Neuer": ("GER", "1"),
        "Dayot Upamecano": ("FRA", "2"),
        "Kim Min-jae": ("KOR", "3"),
        "Jonathan Tah": ("GER", "4"),
        "Joshua Kimmich": ("GER", "6"),
        "Serge Gnabry": ("GER", "7"),
        "Leon Goretzka": ("GER", "8"),
        "Harry Kane": ("ENG", "9"),
        "Jamal Musiala": ("GER", "10"),
        "Nicolas Jackson": ("SEN", "11"),
        "Luis Díaz": ("COL", "14"),
        "Michael Olise": ("FRA", "17"),
        "Alphonso Davies": ("CAN", "19"),
        # Additional players with known nationalities
        "Wojciech Szczęsny": ("POL", ""),
        "Eric García": ("ESP", ""),
        "Fermín López": ("ESP", ""),
        "Marc Casadó": ("ESP", ""),
        "Dani Olmo": ("ESP", ""),
        "Marc Bernal": ("ESP", ""),
        "Gerard Martín": ("ESP", ""),
        "Marcus Bettinelli": ("ENG", "13"),
        "Rayan Aït-Nouri": ("ALG", "21"),
        "Abdukodir Khusanov": ("UZB", "45"),
        "Rico Lewis": ("ENG", "82"),
        "Tijjani Reijnders": ("NED", "4"),
        "Mateo Kovačić": ("CRO", "8"),
        "Rayan Cherki": ("FRA", "10"),
        "Jérémy Doku": ("BEL", "11"),
        "Nico González": ("ESP", "14"),
        "Savinho": ("BRA", "26"),
        "Matheus Nunes": ("POR", "27"),
        "Kalvin Phillips": ("ENG", "44"),
        "Oscar Bobb": ("NOR", "52"),
        "Omar Marmoush": ("EGY", "7"),
        "Filip Jörgensen": ("DEN", "12"),
        "Gabriel Slonina": ("USA", "44"),
        "Tosin Adarabioyo": ("ENG", "4"),
        "Benoît Badiashile": ("FRA", "5"),
        "Levi Colwill": ("ENG", "6"),
        "Jorrel Hato": ("NED", "21"),
        "Trevoh Chalobah": ("ENG", "23"),
        "Malo Gusto": ("FRA", "27"),
        "Wesley Fofana": ("FRA", "29"),
        "Josh Acheampong": ("ENG", "34"),
        "Dário Essugo": ("POR", "14"),
        "Andrey Santos": ("BRA", "17"),
        "Facundo Buonanotte": ("ARG", "40"),
        "Roméo Lavia": ("BEL", "45"),
        "Reggie Walsh": ("ENG", "46"),
        "Pedro Neto": ("POR", "7"),
        "Liam Delap": ("ENG", "9"),
        "Jamie Gittens": ("ENG", "11"),
        "João Pedro": ("BRA", "20"),
        "Tyrique George": ("ENG", "32"),
        "Marc Guiu": ("ESP", "38"),
        "Estêvão": ("BRA", "41"),
        "Alejandro Garnacho": ("ARG", "49"),
        "Shim Mheuka": ("FRA", "62"),
        "Joe Gomez": ("ENG", "2"),
        "Milos Kerkez": ("HUN", "6"),
        "Hugo Ekitike": ("FRA", "22"),
        "Giorgi Mamardashvili": ("GEO", "25"),
        "Freddie Woodman": ("ENG", "28"),
        "Jeremie Frimpong": ("NED", "30"),
        "Ryan Gravenberch": ("NED", "38"),
        "Curtis Jones": ("ENG", "17"),
        "Giovanni Leoni": ("ITA", "15"),
        "Calvin Ramsay": ("SCO", "47"),
        "Kaide Gordon": ("ENG", "49"),
        "Trent Koné-Doherty": ("IRL", "51"),
        "Amara Nallo": ("ENG", "65"),
        "Kieran Morrison": ("NIR", "68"),
        "Rio Ngumoha": ("ENG", "73"),
        "Jayden Danns": ("ENG", "76"),
        "Wellity Lucky": ("ENG", "92"),
        "Harvey Elliott": ("ENG", "19"),
        "Antonín Kinský": ("CZE", "31"),
        "Brandon Austin": ("ENG", "40"),
        "Djed Spence": ("ENG", "24"),
        "Kōta Takai": ("JPN", "25"),
        "Dane Scarlett": ("ENG", "44"),
        "Luka Vušković": ("CRO", "16"),
        "Yang Min-hyeok": ("KOR", "18"),
        "Manor Solomon": ("ISR", "27"),
        "Ashley Phillips": ("ENG", "35"),
        "Alejo Véliz": ("ARG", "36"),
        "Alfie Devine": ("ENG", "45"),
        "Juan Musso": ("ARG", "1"),
        "José María Giménez": ("URU", "2"),
        "Matteo Ruggeri": ("ITA", "3"),
        "Conor Gallagher": ("ENG", "4"),
        "Johnny Cardoso": ("USA", "5"),
        "Koke": ("ESP", "6"),
        "Antoine Griezmann": ("FRA", "7"),
        "Pablo Barrios": ("ESP", "8"),
        "Alexander Sørloth": ("NOR", "9"),
        "Álex Baena": ("ESP", "10"),
        "Thiago Almada": ("ARG", "11"),
        "Carlos Martín": ("ESP", "12"),
        "Eduardo Camavinga": ("FRA", "12"),
        # Additional missing players
        "Nico O'Reilly": ("ENG", ""),
        "Wojciech Szczęsny": ("POL", "31"),
        "Eric García": ("ESP", "24"),
        "Fermín López": ("ESP", "16"),
        "Marc Casadó": ("ESP", "32"),
        "Dani Olmo": ("ESP", "19"),
        "Marc Bernal": ("ESP", "22"),
        "Gerard Martín": ("ESP", "18"),
    }
    
    if name in known_players:
        return known_players[name]
    
    # Try to search Wikipedia for the player
    try:
        search_url = f"https://en.wikipedia.org/wiki/{name.replace(' ', '_')}"
        soup = fetch_soup(search_url)
        if soup:
            # Look for nationality in infobox
            infobox = soup.find("table", class_="infobox")
            if infobox:
                # Find nationality
                country = ""
                for row in infobox.find_all("tr"):
                    header = row.find("th")
                    if header and ("nationality" in header.get_text().lower() or "country" in header.get_text().lower()):
                        country_cell = row.find("td")
                        if country_cell:
                            link = country_cell.find("a")
                            if link:
                                country = link.get_text(strip=True)
                                # Convert to country code if needed
                                country_map = {
                                    "Spain": "ESP", "Spanish": "ESP",
                                    "Netherlands": "NED", "Dutch": "NED",
                                    "England": "ENG", "English": "ENG",
                                    "France": "FRA", "French": "FRA",
                                    "Germany": "GER", "German": "GER",
                                    "Brazil": "BRA", "Brazilian": "BRA",
                                    "Argentina": "ARG", "Argentine": "ARG",
                                    "Portugal": "POR", "Portuguese": "POR",
                                    "Italy": "ITA", "Italian": "ITA",
                                    "Belgium": "BEL", "Belgian": "BEL",
                                    "Uruguay": "URU", "Uruguayan": "URU",
                                    "Colombia": "COL", "Colombian": "COL",
                                    "Sweden": "SWE", "Swedish": "SWE",
                                    "Norway": "NOR", "Norwegian": "NOR",
                                    "Denmark": "DEN", "Danish": "DEN",
                                    "Poland": "POL", "Polish": "POL",
                                    "Croatia": "CRO", "Croatian": "CRO",
                                    "Serbia": "SRB", "Serbian": "SRB",
                                    "Ghana": "GHA", "Ghanaian": "GHA",
                                    "Senegal": "SEN", "Senegalese": "SEN",
                                    "Egypt": "EGY", "Egyptian": "EGY",
                                    "Japan": "JPN", "Japanese": "JPN",
                                    "South Korea": "KOR", "Korean": "KOR",
                                    "Australia": "AUS", "Australian": "AUS",
                                    "Canada": "CAN", "Canadian": "CAN",
                                    "United States": "USA", "American": "USA",
                                    "Mexico": "MEX", "Mexican": "MEX",
                                    "Hungary": "HUN", "Hungarian": "HUN",
                                    "Romania": "ROU", "Romanian": "ROU",
                                    "Austria": "AUT", "Austrian": "AUT",
                                    "Switzerland": "SUI", "Swiss": "SUI",
                                    "Wales": "WAL", "Welsh": "WAL",
                                    "Scotland": "SCO", "Scottish": "SCO",
                                    "Northern Ireland": "NIR", "Northern Irish": "NIR",
                                    "Republic of Ireland": "IRL", "Irish": "IRL",
                                    "Georgia": "GEO", "Georgian": "GEO",
                                }
                                country = country_map.get(country, country)
                                break
                
                return (country, "")
    except Exception:
        pass
    
    return ("", "")


def is_valid_player_row(row: dict[str, Any]) -> bool:
    """Check if a row represents a valid player (not a coach, header, etc.)."""
    name = row.get("Name", "").strip()
    position = row.get("Position", "").strip().lower()
    
    # Skip invalid entries
    invalid_names = {"apps", "goals", "2", "spain", "france", "netherlands"}
    if name.lower() in invalid_names or len(name) < 2:
        return False
    
    # Skip coaches and staff
    invalid_positions = {"manager", "coach", "assistant coaches", "goalkeeping coach", "—"}
    if position in invalid_positions:
        return False
    
    # Must have a name
    if not name:
        return False
    
    return True


def fill_missing_data(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Fill in missing nationalities and shirt numbers for players.
    Uses known data and web search as fallback.
    """
    print("\nFilling missing data...")
    filled_count = 0
    valid_rows = []
    
    for row in rows:
        # Filter out invalid rows
        if not is_valid_player_row(row):
            continue
            
        valid_rows.append(row)
        
        name = row.get("Name", "")
        team = row.get("Team", "")
        country = row.get("Country", "").strip()
        shirt_number = row.get("Shirt Number", "").strip()
        
        # Check known players first (fast)
        found_country, found_number = search_player_info(name, team)
        
        if not country and found_country:
            row["Country"] = found_country
            filled_count += 1
        
        if not shirt_number and found_number:
            row["Shirt Number"] = found_number
            filled_count += 1
    
    print(f"\nFilled {filled_count} missing fields.")
    print(f"Filtered out {len(rows) - len(valid_rows)} invalid rows.")
    return valid_rows


def main():
    all_rows: list[dict[str, Any]] = []

    for club in CLUBS:
        club_rows = fetch_club_squad(club)
        all_rows.extend(club_rows)

    # Fill missing data
    all_rows = fill_missing_data(all_rows)

    output_path = Path("data/squads_2025_26.csv")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with output_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["Name", "Team", "Country", "Position", "League", "Shirt Number"],
        )
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"\nDone. Wrote {len(all_rows)} rows to {output_path!r}")


if __name__ == "__main__":
    main()


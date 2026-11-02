"""Which circuit outline (static/vendor/circuits.json) belongs to a race."""
import re

# Jolpica circuitId -> outline id
BY_API_ID = {
    "albert_park": "au-1953", "shanghai": "cn-2004", "suzuka": "jp-1962", "miami": "us-2022",
    "villeneuve": "ca-1978", "monaco": "mc-1929", "catalunya": "es-1991", "red_bull_ring": "at-1969",
    "silverstone": "gb-1948", "spa": "be-1925", "hungaroring": "hu-1986", "zandvoort": "nl-1948",
    "monza": "it-1922", "madring": "es-2026", "baku": "az-2016", "sepang": "my-1999",
    "marina_bay": "sg-2008", "americas": "us-2012", "rodriguez": "mx-1962", "interlagos": "br-1940",
    "vegas": "us-2023", "las_vegas": "us-2023", "losail": "qa-2004", "yas_marina": "ae-2009",
    "bahrain": "bh-2002", "jeddah": "sa-2021", "imola": "it-1953", "ricard": "fr-1969",
    "portimao": "pt-2008", "istanbul": "tr-2005", "nurburgring": "de-1927", "mugello": "it-1914",
    "sochi": "ru-2014", "hockenheimring": "de-1932", "indianapolis": "us-1909",
}

# words in a race name -> outline id (used when the official calendar isn't reachable)
BY_WORD = {
    "melbourne": "au-1953", "albert": "au-1953", "australia": "au-1953", "shanghai": "cn-2004", "china": "cn-2004",
    "suzuka": "jp-1962", "japan": "jp-1962", "miami": "us-2022", "montreal": "ca-1978", "canada": "ca-1978",
    "monaco": "mc-1929", "barcelona": "es-1991", "catalunya": "es-1991", "austria": "at-1969", "spielberg": "at-1969",
    "silverstone": "gb-1948", "britain": "gb-1948", "british": "gb-1948", "spa": "be-1925", "belgium": "be-1925",
    "hungary": "hu-1986", "budapest": "hu-1986", "zandvoort": "nl-1948", "dutch": "nl-1948", "monza": "it-1922",
    "italy": "it-1922", "imola": "it-1953", "madrid": "es-2026", "madring": "es-2026", "baku": "az-2016",
    "azerbaijan": "az-2016", "bahrain": "bh-2002", "sakhir": "bh-2002", "sepang": "my-1999", "malaysia": "my-1999",
    "singapore": "sg-2008", "austin": "us-2012", "cota": "us-2012", "mexico": "mx-1962", "brazil": "br-1940",
    "interlagos": "br-1940", "vegas": "us-2023", "qatar": "qa-2004", "lusail": "qa-2004", "abu": "ae-2009",
    "yas": "ae-2009", "jeddah": "sa-2021", "saudi": "sa-2021", "portimao": "pt-2008", "istanbul": "tr-2005",
}


def guess(title):
    for word in re.split(r"[^a-z]+", (title or "").lower()):
        if word in BY_WORD:
            return BY_WORD[word]
    return None

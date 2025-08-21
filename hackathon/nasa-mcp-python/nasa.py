from typing import Any
import httpx
from mcp.server.fastmcp import FastMCP

# Initialize FastMCP server
mcp = FastMCP("nasa")

# Constants
NASA_API_BASE = "https://api.nasa.gov"
NASA_API_KEY = "<NASA_API_TOKEN>"

async def make_nasa_request(url: str) -> dict[str, Any] | None:
    """Make a request to the NASA API with proper error handling."""
    params = {"api_key": NASA_API_KEY}
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=30.0)
            response.raise_for_status()
            return response.json()
        except Exception:
            return None

@mcp.tool()
async def get_astronomy_picture_of_day(date: str = None) -> str:
    """Get NASA's Astronomy Picture of the Day (APOD).
    
    Args:
        date: Optional date in YYYY-MM-DD format. If not provided, returns today's image.
    """
    url = f"{NASA_API_BASE}/planetary/apod"
    
    if date:
        url += f"?date={date}"
    
    data = await make_nasa_request(url)
    
    if not data:
        return "Unable to fetch APOD data from NASA API."
    
    # Get the image URL (prefer HD if available)
    image_url = data.get('hdurl') or data.get('url')
    
    # Format the response with markdown image
    result = f"""
🌌 NASA Astronomy Picture of the Day

📅 Date: {data.get('date', 'Unknown')}
📝 Title: {data.get('title', 'Unknown')}
👨‍🚀 Author: {data.get('copyright', 'NASA')}
📖 Explanation: {data.get('explanation', 'No explanation available')}

{image_url and f"![{data.get('title', 'NASA APOD')}]({image_url})" or "No image available"}
"""
    
    return result

if __name__ == "__main__":
    mcp.run(transport='stdio')
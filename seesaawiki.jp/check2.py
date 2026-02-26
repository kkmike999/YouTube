import requests
from bs4 import BeautifulSoup
import sys

sys.stdout.reconfigure(encoding='utf-8')
url = "https://seesaawiki.jp/avsagasou/d/2026~~%a3%b1%b7%ee"
response = requests.get(url)
response.encoding = 'euc-jp'
soup = BeautifulSoup(response.text, 'html.parser')

table = soup.find('table', id='content_block_1')
rows = table.find_all('tr')
for i, row in enumerate(rows[:2]):
    cols = row.find_all(['th', 'td'])
    print(f"--- Row {i} ---")
    for j, col in enumerate(cols):
        print(f"Col {j}: {col}")

import requests
from bs4 import BeautifulSoup
import sys

sys.stdout.reconfigure(encoding='utf-8')

url = "https://seesaawiki.jp/avsagasou/d/2026~~%a3%b1%b7%ee"
response = requests.get(url)
response.encoding = 'euc-jp'
text = response.text

soup = BeautifulSoup(text, 'html.parser')

print("=== TITLE SEARCH ===")
titles = soup.select('div.title div.inner div.inner h2')
for t in titles:
    print(t.text.strip())

titles2 = soup.select('div.title h2')
for t in titles2:
    print("Fallback:", t.text.strip())

print("\n=== TABLE SEARCH ===")
table = soup.find('table', id='content_block_1')
if table:
    rows = table.find_all('tr')
    if len(rows) > 0:
        print("Header length:", len(rows[0].find_all(['th', 'td'])))
        for i, row in enumerate(rows[:2]):
            cols = row.find_all(['th', 'td'])
            print(f"Row {i} has {len(cols)} columns")
            if i == 1 and len(cols) >= 5:
                # First col text
                first_text = next(cols[0].stripped_strings, "")
                print(f"First line text of Col 0: '{first_text}'")

                # extracting 3rd href from 5th column
                links = cols[4].find_all('a', href=True)
                if len(links) >= 3:
                    print("3rd link in Col 4:", links[2].get('href'))
                else:
                    print(f"Only found {len(links)} links in Col 4")

import requests
from bs4 import BeautifulSoup

url = "https://seesaawiki.jp/avsagasou/d/2026~~%a3%b1%b7%ee"
response = requests.get(url)
response.encoding = 'euc-jp' 
soup = BeautifulSoup(response.text, 'html.parser')

# <div class="title"><div class="inner">里的<div class="inner">里的<H2>
title_h2 = soup.select_one('div.title div.inner div.inner h2')
print("Title:", title_h2.text.strip() if title_h2 else "None")

table = soup.find('table', id='content_block_1')
if table:
    rows = table.find_all('tr')
    for i, row in enumerate(rows[:3]):
        cols = row.find_all(['th', 'td'])
        print(f"Row {i}:")
        for j, c in enumerate(cols):
            print(f"  Col {j} HTML:\n=====\n{c.decode_contents().strip()}\n=====")

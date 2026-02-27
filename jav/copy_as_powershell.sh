$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
$session.Cookies.Add((New-Object System.Net.Cookie("existmag", "mag", "/", "www.javbus.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("4fJN_2132_lastcheckfeed", "475480%7C1764758174", "/", "www.javbus.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("4fJN_2132_auth", "dc53q1HSxBjoxDcGCTZwr%2FI5C7B1jHphQOinjtM36nbQJB6yxFt%2BdId6rRIdQ%2F3reRQn3%2FSe%2BCfH3gnfT8lF2NuKYf8", "/", "www.javbus.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("4fJN_2132_nofavfid", "1", "/", "www.javbus.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("4fJN_2132_ulastactivity", "fabaynszAhMg2bXY46AH7EW16SsX5EcOpSWnKfl9HWcLxlN8dDKv", "/", "www.javbus.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("4fJN_2132_visitedfid", "36D2", "/", "www.javbus.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("starinfo", "glyphicon%20glyphicon-minus", "/", "www.javbus.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("PHPSESSID", "v3tsgvjuhelblb4r53ddnanfv5", "/", "www.javbus.com")))
Invoke-WebRequest -UseBasicParsing -Uri "https://www.javbus.com/JUR-354" `
-WebSession $session `
-Headers @{
"authority"="www.javbus.com"
  "method"="GET"
  "path"="/JUR-354"
  "scheme"="https"
  "accept"="text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
  "accept-encoding"="gzip, deflate, br, zstd"
  "accept-language"="zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7"
  "cache-control"="max-age=0"
  "priority"="u=0, i"
  "sec-ch-ua"="`"Not(A:Brand`";v=`"8`", `"Chromium`";v=`"144`", `"Google Chrome`";v=`"144`""
  "sec-ch-ua-mobile"="?0"
  "sec-ch-ua-platform"="`"Windows`""
  "sec-fetch-dest"="document"
  "sec-fetch-mode"="navigate"
  "sec-fetch-site"="none"
  "sec-fetch-user"="?1"
  "upgrade-insecure-requests"="1"
}


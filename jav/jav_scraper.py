import requests
from bs4 import BeautifulSoup
import time
import re

def extract_code(line):
    # 提取番号，查找类似于 "字母-数字" 的模式
    match = re.search(r'[A-Za-z]+-\d+', line)
    if match:
        return match.group(0)
    return None

def parse_size(size_str):
    """
    将文件大小字符串转换为字节用于比较
    例如: "1.5GB" -> 1610612736, "500MB" -> 524288000
    """
    size_str = size_str.upper().strip()
    if not size_str:
        return 0
    
    # 移除可能的非数字字符（除了点和单位）
    number_part = re.search(r'[\d\.]+', size_str)
    if not number_part:
        return 0
        
    value = float(number_part.group())
    
    if 'GB' in size_str:
        return value * 1024 * 1024 * 1024
    elif 'MB' in size_str:
        return value * 1024 * 1024
    elif 'KB' in size_str:
        return value * 1024
    return value

def get_best_magnet(soup):
    """
    解析磁力表格并根据规则筛选最佳磁力链接
    规则：
    1. 磁力名称带有 '4K' 优先
    2. 大小最大优先
    """
    magnet_table = soup.find('table', id='magnet-table')
    if not magnet_table:
        return None

    magnets = []
    
    # 遍历表格行 (跳过表头，如果有)
    rows = magnet_table.find_all('tr')
    for row in rows:
        cols = row.find_all('td')
        if len(cols) < 3:
            continue
            
        # 解析第一列：磁力名称和链接
        name_col = cols[0]
        link_tag = name_col.find('a')
        if not link_tag:
            continue
            
        magnet_name = link_tag.get_text(strip=True)
        magnet_link = link_tag.get('href', '')
        
        # 解析第二列：大小
        size_str = cols[1].get_text(strip=True)
        size_bytes = parse_size(size_str)
        
        # 解析第三列：日期
        date_str = cols[2].get_text(strip=True)
        
        magnets.append({
            'name': magnet_name,
            'size_str': size_str,
            'size_bytes': size_bytes,
            'date': date_str,
            'link': magnet_link
        })
    
    if not magnets:
        return None
        
    # 筛选逻辑
    # 1. 找出包含 "4K" 的条目
    k4_magnets = [m for m in magnets if '4K' in m['name'].upper()]
    
    if k4_magnets:
        # 如果有 4K，取 4K 中最大的
        return max(k4_magnets, key=lambda x: x['size_bytes'])
    else:
        # 否则取所有列表中最大的
        return max(magnets, key=lambda x: x['size_bytes'])

def get_jav_info(code):
    url = f"https://www.javbus.com/{code}"
    # 伪装成浏览器
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Referer": "https://www.javbus.com/"
    }
    
    try:
        # 添加 Cookies 以绕过年龄验证
        cookies = {
            'existmag': 'all',
            'dv': '1',
            'age': 'verified'
        }
        
        # 发送请求
        response = requests.get(url, headers=headers, cookies=cookies, timeout=15)
        
        # 检查响应状态
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            # 查找 h3 标签 (通常包含标题)
            title_tag = soup.find('h3')
            title = title_tag.get_text(strip=True) if title_tag else "未找到标题"
            
            # 提取 AJAX 请求所需的参数
            gid_match = re.search(r"var gid = (\d+);", response.text)
            uc_match = re.search(r"var uc = (\d+);", response.text)
            img_match = re.search(r"var img = '([^']+)';", response.text)
            
            best_magnet = None
            if gid_match and uc_match and img_match:
                gid = gid_match.group(1)
                uc = uc_match.group(1)
                img = img_match.group(1)
                
                # 构造 AJAX 请求 URL
                floor = int(time.time() * 1000) % 1000 + 1
                ajax_url = f"https://www.javbus.com/ajax/uncledatoolsbyajax.php?gid={gid}&lang=zh&img={img}&uc={uc}&floor={floor}"
                
                try:
                    ajax_response = requests.get(ajax_url, headers=headers, cookies=cookies, timeout=15)
                    if ajax_response.status_code == 200:
                        # AJAX 返回的是 HTML 片段 (tr 标签)
                        # 我们创建一个假的 table 来包裹它以便 BeautifulSoup 解析
                        ajax_html = f"<table>{ajax_response.text}</table>"
                        ajax_soup = BeautifulSoup(ajax_html, 'html.parser')
                        # 直接用 ajax_soup 调用 get_best_magnet，需要稍微修改 get_best_magnet 适配
                        # 或者在这里直接解析
                        
                        # 为了复用 get_best_magnet，我们构造一个包含 id='magnet-table' 的 soup
                        # 或者简单点，我们修改 get_best_magnet 让它接受 table 元素或 tr 列表
                        # 简单的做法：修改 get_best_magnet 来查找 tr
                        
                        # 让我们重写 get_best_magnet 的调用方式
                        # 仅仅为了方便，这里直接构造一个符合 get_best_magnet 预期的结构
                        dummy_soup = BeautifulSoup(f"<table id='magnet-table'>{ajax_response.text}</table>", 'html.parser')
                        best_magnet = get_best_magnet(dummy_soup)
                        
                except Exception as e:
                    print(f"获取磁力链接失败: {e}")
            
            return title, url, best_magnet
        else:
            return f"请求失败: {response.status_code}", url, None
            
    except Exception as e:
        return f"发生错误: {str(e)}", url, None


from tabulate import tabulate

def main():
    print("开始获取数据...\n")
    
    try:
        with open('content.txt', 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except FileNotFoundError:
        print("错误：未找到 content.txt 文件，请确保该文件在同一目录下。")
        return
    except Exception as e:
        print(f"读取文件出错: {e}")
        return

    codes = []
    
    # 提取番号
    for line in lines:
        code = extract_code(line)
        if code:
            codes.append(code)
    
    if not codes:
        print("未在 content.txt 中提取到任何番号。")
        return

    # 准备数据收集
    headers = ["番号", "标题", "链接", "磁力名稱", "檔案大小", "分享日期", "磁力链"]
    table_data = []
    magnet_links = []
    
    # 打印控制台表格头 (简单显示进度)
    print("| 番号 | 标题 |")
    print("|---|---|")
    
    # 遍历每个番号获取信息
    for code in codes:
        title, url, magnet = get_jav_info(code)
        
        # 清理标题中的特殊字符
        clean_title = title.replace('|', '-').replace('\n', ' ')
        
        if magnet:
            m_name = magnet['name'].replace('|', '-').replace('\n', '')
            m_size = magnet['size_str']
            m_date = magnet['date']
            m_link = magnet['link']
            # 收集磁力链
            magnet_links.append(m_link)
        else:
            m_name = "未找到磁力"
            m_size = "-"
            m_date = "-"
            m_link = "-"
        
        # 添加到表格数据
        table_data.append([code, clean_title, url, m_name, m_size, m_date, m_link])
        
        # 控制台打印进度
        print(f"| {code} | {clean_title} |")
        
        # 适当延时
        time.sleep(1)
    
    # 使用 tabulate 格式化并写入 result.md
    output_file = 'result.md'
    with open(output_file, 'w', encoding='utf-8') as f_out:
        # 写入格式化后的表格
        f_out.write(tabulate(table_data, headers=headers, tablefmt="github"))
        
        # 追加磁力链列表
        if magnet_links:
            f_out.write('\n\n')
            f_out.write('-----磁力链列表-----\n')
            f_out.write('\n\n')
            for link in magnet_links:
                f_out.write(link + '\n')
        
    print(f"\n完成！结果已保存至 {output_file}")

if __name__ == "__main__":
    main()

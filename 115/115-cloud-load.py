import json
import os
import sys
import time
import argparse
import urllib.parse

try:
    from DrissionPage import ChromiumPage
    from DrissionPage.common import Settings
except ImportError:
    print("错误: 未安装 DrissionPage。请先在终端中运行 'pip install DrissionPage'")
    sys.exit(1)

def check_115_login_with_dp(cookie_file, cloud_load_url=None):
    if cloud_load_url:
        cloud_load_url = urllib.parse.unquote(cloud_load_url)
    print(f"check_115_login_with_dp: cookie_file={cookie_file}, cloud_load_url={cloud_load_url}")
    
    if not os.path.exists(cookie_file):
        print(f"错误: 找不到 Cookie 文件: {cookie_file}")
        return

    # 1. 尝试读取和解析 JSON cookie 文件
    try:
        with open(cookie_file, 'r', encoding='utf-8') as f:
            cookies_list = json.load(f)
    except Exception as e:
        print(f"读取或解析 Cookie JSON 文件失败: {e}")
        return
        
    # 格式化 cookies 适应 DrissionPage 的要求
    # DrissionPage 的 set.cookies() 接受字典列表，通常包含 name, value, domain 等键
    dp_cookies = []
    for c in cookies_list:
        if 'name' in c and 'value' in c:
            dp_cookie = {
                'name': c['name'],
                'value': c['value'],
                'domain': c.get('domain', ''),
                'path': c.get('path', '/')
            }
            dp_cookies.append(dp_cookie)

    print("正在启动 Chromium... (请保持关注弹出的浏览器窗口)")
    try:
        # 使用 DrissionPage 启动浏览器
        page = ChromiumPage()
    except Exception as e:
        print(f"启动浏览器失败: {e}")
        return

    # 2. 访问 115 域，提前注入 Cookie 
    # 注意：必须要先访问该域名或同父域名下的任意 URL 才能设置该域名的 Cookie，这是浏览器的安全限制
    print("正在预访问 115.com 以注入 Cookies...")
    page.get("https://115.com/404") 
    
    print(f"正在注入 {len(dp_cookies)} 个 Cookies...")
    for cookie in dp_cookies:
        try:
             page.set.cookies(cookie)
        except:
             pass

    # 3. 访问 115 主页进行状态检测
    home_url = "https://115.com/"
    print(f"正在访问 {home_url} 进行状态检测...")
    page.get(home_url)
    
    # 等待页面加载
    print("等待页面加载完成，进行状态检测...")
    
    is_logged_in = False
    # 4. 根据页面 DOM 元素特征判断状态
    try:
        # 检测是否出现新版登录卡片组件 (未登录标志)
        if page.ele('tag:login-card', timeout=5):
            print("【状态: 未登录】(检测到 <login-card> 登录组件框)")
        
        # 现代版 115 登录界面的右上角用户头像容器通常存在特定的 class 或者通过 iframe 判断
        elif page.ele('@class=login-finished', timeout=2):
             print("【状态: 已登录】(检测到传统的 login-finished 元素)")
             is_logged_in = True
             
        elif page.ele('@@class:user-info@@tag:div', timeout=2) or page.ele('@@id:js_top_panel_box@@tag:div', timeout=2):
             print("【状态: 已登录】(检测到用户个人信息面板区域)")
             is_logged_in = True
        else:
            print("【状态: 未知】(页面未出现明显的登录框，但也未发现已登录的特征元素，请手动观察弹出的浏览器核实)")
            
        
        # 重定向到 云下载
        wangpan_url = "https://115.com/?mode=wangpan"
        print(f"正在重定向到 云下载 {wangpan_url} ...")
        page.get(wangpan_url)

        # 5. 如果已登录并且存在云下载链接参数，则自动添加离线任务
        if is_logged_in and cloud_load_url:
            print(f"\n准备添加云下载任务: {cloud_load_url}")

            # 给页面一点加载时间以防元素未渲染完全
            time.sleep(2)
            
            # 先将包含“添加云下载”菜单项的父容器的 display 属性改为 block，使其可见
            try:
                dropdown = page.ele('.context-menu[data-dropdown-content="upload_btn_add_dir"]', timeout=3)
                if dropdown:
                    dropdown.run_js('this.style.display="block";')
            except Exception as e:
                print(f"显示菜单项失败 (可忽略): {e}")

            # 点击添加云下载按钮，要求更严格的定位，必须包含特定的 i 标签
            add_btn = page.ele('xpath://a[@menu="offline_task" and .//i[contains(@class, "ifo-linktask")]]', timeout=5)
            if add_btn:
                add_btn.click(by_js=True)
                print("已点击【添加云下载】按钮")
                
                # 等待弹窗并输入链接
                textarea = page.ele('#js_offline_new_add', timeout=5)
                if textarea:
                    textarea.input(cloud_load_url)
                    print("已输入下载链接")
                    
                    # 点击开始下载按钮
                    start_btn = page.ele('@data-btn=start', timeout=5)
                    if start_btn:
                        start_btn.click()
                        print("已点击【开始下载】按钮")
                        
                        # 等5秒后刷新界面
                        print("等待 5 秒...")
                        time.sleep(5)
                        print("正在刷新界面...")
                        page.refresh()
                    else:
                        print("未找到【开始下载】按钮")
                else:
                    print("未找到链接输入框")
            else:
                print("未找到【添加云下载】按钮")
            
    except Exception as e:
         print(f"【状态: 检查或操作过程出错】: {e}")

    # 重定向到 云下载
    wangpan_url = "https://115.com/?mode=wangpan"
    print(f"正在重定向到 云下载 {wangpan_url} ...")
    page.get(wangpan_url)
    
    print("\n操作完毕。浏览器实例将在 10 秒后自动关闭。")
    time.sleep(10)
    page.quit()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="115 Cloud Load Script")
    # 兼容之前的文件参数，默认为 d:\YouTube\115\cookies_115.json
    parser.add_argument("cookie_file", nargs='?', default=r"d:\YouTube\115\cookies_115.json", help="Path to cookie file")
    # 新增 --cloud-load 选项用于接收链接
    parser.add_argument("--cloud-load", dest="cloud_load_url", help="离线下载链接")
    
    args = parser.parse_args()
    
    check_115_login_with_dp(args.cookie_file, args.cloud_load_url)

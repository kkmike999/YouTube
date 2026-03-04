import json
import os
import sys
import time
import argparse
import urllib.parse
from pathlib import Path

try:
    from DrissionPage import ChromiumPage
    from DrissionPage.common import Settings
except ImportError:
    print("错误: 未安装 DrissionPage。请先在终端中运行 'pip install DrissionPage'")
    sys.exit(1)

# 读取 jav/temp/${番号}.md
def read_bangou_row(bangou, cloud_load_url=None):
    """
    读取 jav/temp/${番号}.md，解析 markdown 表格，找到番号列匹配的行，返回该行所有元素组成的 dict。
    若 cloud_load_url 为空且找到行中有磁力链，则一并返回填充后的 cloud_load_url。
    返回 (row_data, cloud_load_url, bangou)，row_data 为 dict 或 None。
    """
    row_data = None
    if not bangou:
        return None, cloud_load_url, bangou

    md_dir = Path(__file__).resolve().parent.parent / "jav" / "temp"
    md_path = md_dir / f"{bangou}.md"
    if not md_path.exists():
        # 大小写不敏感匹配文件名
        bangou_lower = bangou.lower()
        for f in md_dir.glob("*.md"):
            if f.stem.lower() == bangou_lower:
                md_path = f
                break
    if not md_path.exists():
        print(f"错误: 找不到文件 {md_path}，请先运行 jav_magnet.py --番号 {bangou} 生成该文件")
        bangou_input = input("请重新输入番号（直接回车跳过）: ").strip()
        if bangou_input:
            bangou = bangou_input
            md_path = md_dir / f"{bangou}.md"
            if not md_path.exists():
                bangou_lower = bangou.lower()
                for f in md_dir.glob("*.md"):
                    if f.stem.lower() == bangou_lower:
                        md_path = f
                        break

    if md_path.exists():
        try:
            content = md_path.read_text(encoding="utf-8")
            lines = [ln.strip() for ln in content.splitlines() if ln.strip() and not ln.strip().startswith("| --")]
            if len(lines) >= 2:
                headers = [c.strip() for c in lines[0].strip("|").split("|")]
                for ln in lines[1:]:
                    cells = [c.strip() for c in ln.strip("|").split("|")]
                    if len(cells) >= 1 and cells[0].lower() == bangou.lower():
                        row_data = dict(zip(headers, cells))
                        if not cloud_load_url and row_data.get("磁力链", "").startswith("magnet:?"):
                            cloud_load_url = row_data["磁力链"]
                        break
        except Exception as e:
            print(f"读取或解析 {md_path} 失败: {e}")

    return row_data, cloud_load_url, bangou


def load_cookies_from_file(cookie_file):
    """读取 Cookie JSON 并转换为 DrissionPage 可用格式。"""
    if not os.path.exists(cookie_file):
        raise FileNotFoundError(f"找不到 Cookie 文件: {cookie_file}")

    try:
        with open(cookie_file, 'r', encoding='utf-8') as f:
            cookies_list = json.load(f)
    except Exception as e:
        raise ValueError(f"读取或解析 Cookie JSON 文件失败: {e}") from e

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

    return dp_cookies

# 预访问 115.com 并注入 Cookies
def inject_cookies(page, dp_cookies):
    """预访问 115 域并注入 Cookies。"""
    print("正在预访问 115.com 以注入 Cookies...")
    page.get("https://115.com/404")

    print(f"正在注入 {len(dp_cookies)} 个 Cookies...")
    for cookie in dp_cookies:
        try:
            page.set.cookies(cookie)
        except Exception:
            pass

# 访问首页并根据 DOM 特征判断登录状态
def detect_login_status(page):
    """访问首页并根据 DOM 特征判断登录状态。"""
    home_url = "https://115.com/"
    print(f"正在访问 {home_url} 进行状态检测...")
    page.get(home_url)
    print("等待页面加载完成，进行状态检测...")

    is_logged_in = False
    if page.ele('tag:login-card', timeout=5):
        print("【状态: 未登录】(检测到 <login-card> 登录组件框)")
    elif page.ele('@class=login-finished', timeout=2):
        print("【状态: 已登录】(检测到传统的 login-finished 元素)")
        is_logged_in = True
    elif page.ele('@@class:user-info@@tag:div', timeout=2) or page.ele('@@id:js_top_panel_box@@tag:div', timeout=2):
        print("【状态: 已登录】(检测到用户个人信息面板区域)")
        is_logged_in = True
    else:
        print("【状态: 未知】(页面未出现明显的登录框，但也未发现已登录的特征元素，请手动观察弹出的浏览器核实)")

    return is_logged_in

# 跳转到网盘页面
def goto_wangpan(page):
    """跳转到网盘页面。"""
    wangpan_url = "https://115.com/?mode=wangpan&cid=739884770980370058"
    print(f"正在重定向到 云下载 {wangpan_url} ...")
    page.get(wangpan_url)

# 在云下载页面添加离线任务
def add_cloud_task(page, cloud_load_url):
    """在云下载页面添加离线任务。"""
    if not cloud_load_url:
        return

    print(f"\n准备添加云下载任务: {cloud_load_url}")
    time.sleep(2)

    try:
        dropdown = page.ele('.context-menu[data-dropdown-content="upload_btn_add_dir"]', timeout=3)
        if dropdown:
            dropdown.run_js('this.style.display="block";')
    except Exception as e:
        print(f"显示菜单项失败 (可忽略): {e}")

    add_btn = page.ele('xpath://a[@menu="offline_task" and .//i[contains(@class, "ifo-linktask")]]', timeout=5)
    if not add_btn:
        print("未找到【添加云下载】按钮")
        return

    add_btn.click(by_js=True)
    print("已点击【添加云下载】按钮")

    textarea = page.ele('#js_offline_new_add', timeout=5)
    if not textarea:
        print("未找到链接输入框")
        return

    textarea.input(cloud_load_url)
    print("已输入下载链接")

    start_btn = page.ele('@data-btn=start', timeout=5)
    if not start_btn:
        print("未找到【开始下载】按钮")
        return

    start_btn.click()
    print("已点击【开始下载】按钮")
    print("等待 2 秒...")
    time.sleep(2)
    print("正在刷新界面...")
    page.refresh()

# 重命名离线下载好的目录，并清理不含番号的文件
# list_cont: 列表容器
# title_text: 列表项的 title 属性值
# 返回: 列表项
def get_list_item_by_title(list_cont, title_text, timeout=3):
    """根据 title 属性查找列表项（自动处理 XPath 单引号转义）。"""
    safe_title_attr = title_text.replace("'", "''")
    return list_cont.ele(f"xpath:.//li[@title='{safe_title_attr}']", timeout=timeout)

# 右键列表项并打开重命名弹窗
def open_rename_dialog(page, li_ele):
    """右键列表项并打开重命名弹窗。"""
    li_ele.click.right()
    time.sleep(0.5)
    rename_item = page.ele('xpath://li[@val="edit_name"]//a[.//span[text()="重命名"]]', timeout=3)
    if not rename_item:
        print("未找到【重命名】菜单项")
        return False
    rename_item.click()
    time.sleep(0.5)
    return True

# 填写并提交重命名
def submit_rename(page, new_title):
    """填写并提交重命名。"""
    txt_area = page.ele('@rel=txt', timeout=3)
    if not txt_area:
        print("未找到重命名输入框")
        return False

    txt_area.input(new_title, clear=True)
    time.sleep(0.3)
    confirm_btn = page.ele('@btn=confirm', timeout=3)
    if not confirm_btn:
        return False

    confirm_btn.click()
    return True

# 选中目录内所有不含番号的文件，返回选中数量
def select_non_bangou_files(page, inner_list, bangou):
    """选中目录内所有不含番号的文件，返回选中数量。"""
    lis = inner_list.eles("xpath:./li", timeout=2)
    selected_count = 0
    for li in lis:
        li_title = li.attr("title") or ""
        if bangou.lower() in li_title.lower():
            print(f"li_title={li_title} 包含番号 {bangou} 跳过")
            continue
        print(f"li_title={li_title} 选中")
        li.run_js('this.className = "selected"')
        selected_count += 1

    return selected_count


# 删除已选文件
def delete_selected_files(page, selected_count):
    """删除已选文件。"""
    if selected_count <= 0:
        return

    operate_box = page.ele('#js_operate_box', timeout=3)
    if not operate_box:
        return

    # 若已有 style display，仅将 display 改为 flex
    operate_box.run_js('''
        this.style.left = "170px";
        if (this.style.display) { this.style.display = "flex"; }
    ''')
    time.sleep(0.2)

    # li 下有 ul，按钮在 ul 内，需点击内部可点击元素
    del_btn = operate_box.ele('xpath:.//li[@menu="delete"]//a', timeout=2)
    if not del_btn:
        del_btn = operate_box.ele('xpath:.//li[@menu="delete"]', timeout=2)
    if not del_btn:
        print(f"未找到删除按钮")
        return

    try:
        del_btn.run_js('this.scrollIntoView({block: "center"});')
        time.sleep(0.2)
    except Exception:
        pass

    del_btn.click(by_js=True)

    time.sleep(2)

    # 1) 先在当前文档里找（修正为合法选择器）
    dlg_confirm = page.ele(
        'css:div.dialog-box.window-current a.dgac-confirm[btn="confirm"]',
        timeout=3,
    )
    if not dlg_confirm:
        dlg_confirm = page.ele(
            'xpath://div[contains(@class,"dialog-box") and contains(@class,"window-current")]//a[@btn="confirm"]',
            timeout=1,
        )
    if not dlg_confirm:
        dlg_confirm = page.ele(
            'xpath://div[contains(@class,"dialog-box") and contains(@class,"window-current")]//a[normalize-space(text())="确定"]',
            timeout=1,
        )

    # 2) 兜底：弹窗常挂在 top document（页面主体在 iframe）
    if not dlg_confirm:
        clicked_in_top = page.run_js(
            '''
            const sel = '.dialog-box.window-current a.dgac-confirm[btn="confirm"]';
            const btn = top.document.querySelector(sel)
                || top.document.querySelector('.dialog-box.window-current a.dgac-confirm');
            if (!btn) return false;
            btn.scrollIntoView({block: "center"});
            btn.click();
            return true;
            '''
        )
        if clicked_in_top:
            print(f"已删除 {selected_count} 个不含番号的文件")
            return

    if dlg_confirm:
        try:
            dlg_confirm.run_js('this.scrollIntoView({block: "center"});')
            time.sleep(0.2)
        except Exception:
            pass
        dlg_confirm.click(by_js=True)
        print(f"已删除 {selected_count} 个不含番号的文件")
    else:
        print("未找到确认按钮（当前文档与 top 文档均未命中）")

# 进入目录后清理不含番号的文件
def cleanup_non_bangou_files_in_dir(page, bangou):
    """进入目录后清理不含番号的文件。"""
    # 先找 list-contents 容器，再在其内找 ul（进入目录后 DOM 可能不同）
    list_cont = page.ele('.list-contents', timeout=5)
    inner_list = list_cont.ele('tag:ul', timeout=3) if list_cont else None
    if not inner_list:
        inner_list = page.ele('.list-contents ul', timeout=2)  # 备用选择器
    if not (inner_list and bangou):
        print(f"inner_list={inner_list}, bangou={bangou} 清理不含番号的文件失败 return")
        return

    # 选中目录内所有不含番号的文件，返回选中数量
    selected_count = select_non_bangou_files(page, inner_list, bangou)
    delete_selected_files(page, selected_count)


def goto_wangpan_by_cid(page, cate_id):
    """按目录 cate_id 跳转到指定网盘目录。"""
    wangpan_url = f"https://115.com/?cid={cate_id}&mode=wangpan"
    print(f"正在跳转到目录: {wangpan_url}")
    page.get(wangpan_url)


# 按 row_data 重命名目录，并清理不含番号的文件
def rename_dir_and_cleanup(page, row_data, bangou):
    """按 row_data 重命名目录，并清理不含番号的文件。"""
    if not row_data:
        return

    time.sleep(4)
    magnet_dir_name = row_data.get("磁力链目录名")
    title = row_data.get("标题")
    if not (magnet_dir_name and title):
        return

    list_cont = page.ele('.list-contents', timeout=5)
    if not list_cont:
        return

    # 根据 title 属性查找列表项（自动处理 XPath 单引号转义）
    li_ele = get_list_item_by_title(list_cont, magnet_dir_name)
    if not li_ele:
        print(f"未找到 title={magnet_dir_name} 的列表项")
        return

    # 右键列表项并打开重命名弹窗
    if not open_rename_dialog(page, li_ele):
        return

    # 填写并提交重命名
    if not submit_rename(page, title):
        return

    print(f"已重命名: {magnet_dir_name} -> {title}")
    time.sleep(1)

    # 根据 title 属性查找列表项（自动处理 XPath 单引号转义）
    #li_by_title = get_list_item_by_title(list_cont, title)
    #if not li_by_title:
    #    return

    cate_id = li_ele.attr('cate_id')
    if cate_id:
        goto_wangpan_by_cid(page, cate_id)
        time.sleep(4)  # 跳转后需等待目录列表渲染
    else:
        li_ele.click()
        time.sleep(4)

    # 进入目录后清理不含番号的文件
    cleanup_non_bangou_files_in_dir(page, bangou)
    # 跳转到"云下载"页面
    goto_wangpan_by_cid(page, '739884770980370058')
    
    time.sleep(1)

# 检查 115 登录状态并添加离线任务
def check_115_login_with_dp(cookie_file, cloud_load_url=None, bangou=None, row_data=None):
    if cloud_load_url:
        cloud_load_url = urllib.parse.unquote(cloud_load_url)
    print(f"check_115_login_with_dp: cookie_file={cookie_file}, cloud_load_url={cloud_load_url}, 番号={bangou}, row_data={row_data}")

    try:
        dp_cookies = load_cookies_from_file(cookie_file)
    except FileNotFoundError as e:
        print(f"错误: {e}")
        return
    except ValueError as e:
        print(e)
        return

    print("正在启动 Chromium... (请保持关注弹出的浏览器窗口)")
    try:
        page = ChromiumPage()
    except Exception as e:
        print(f"启动浏览器失败: {e}")
        return

    try:
        inject_cookies(page, dp_cookies)
        is_logged_in = detect_login_status(page)
        goto_wangpan(page)

        if is_logged_in and cloud_load_url:
            add_cloud_task(page, cloud_load_url)
    except Exception as e:
        print(f"【状态: 检查或操作过程出错】: {e}")

    goto_wangpan(page)
    try:
        rename_dir_and_cleanup(page, row_data, bangou)
    except Exception as e:
        print(f"重命名过程出错: {e}")

    print("\n操作完毕。浏览器实例将在 10 秒后自动关闭。")
    time.sleep(10)
    page.quit()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="115 Cloud Load Script")
    # 兼容之前的文件参数，默认为 d:\YouTube\115\cookies_115.json
    parser.add_argument("cookie_file", nargs='?', default=None, help="Path to cookie file")
    # 新增 --cloud-load 选项用于接收链接
    parser.add_argument("--cloud-load", dest="cloud_load_url", help="离线下载链接")
    parser.add_argument("--番号", dest="bangou", help="番号")
    
    args = parser.parse_args()
    default_cookie = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies_115.json")
    
    # 如果一个参数都没输入，则逐个提示用户输入（可直接回车跳过）
    if len(sys.argv) == 1:
        print("未提供任何参数，将逐个提示输入（可直接回车跳过）\n")
        if os.path.exists(default_cookie):
            cookie_file = default_cookie
        else:
            cookie_input = input(f"Cookie 文件路径 [cookies_115.json 不存在]: ").strip()
            cookie_file = cookie_input or default_cookie
        cloud_load_input = input("离线下载链接 [默认: 不添加]: ").strip()
        cloud_load_url = cloud_load_input if cloud_load_input else None
        bangou_input = input("番号 [默认: 不添加]: ").strip()
        bangou = bangou_input if bangou_input else None
    else:
        cookie_file = args.cookie_file or default_cookie
        cloud_load_url = args.cloud_load_url
        bangou = args.bangou

    if cloud_load_url and not cloud_load_url.strip().startswith('magnet:?'):
        print("错误: 离线下载链接必须以 'magnet:?' 开头")
        sys.exit(1)

    row_data, cloud_load_url, bangou = read_bangou_row(bangou, cloud_load_url)

    check_115_login_with_dp(cookie_file, cloud_load_url, bangou, row_data)

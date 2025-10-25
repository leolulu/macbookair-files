import os
import re
from pathlib import Path

from bs4 import BeautifulSoup


def extract_image_text_mapping(folder_path):
    """
    从HTML文件中提取图片与文本的映射关系
    
    Args:
        folder_path: 包含messages.html和photos目录的文件夹路径
    
    Returns:
        dict: 图片文件名到对应文本内容的映射
    """
    photos_path = os.path.join(folder_path, 'photos')
    
    # 检查photos目录是否存在，如果不存在则创建一个虚拟的映射
    photos_exists = os.path.exists(photos_path)
    if not photos_exists:
        print(f"警告: 找不到目录 {photos_path}，将仅提取文本内容而不创建TXT文件")
    
    # 查找所有messages*.html文件
    html_files = []
    for file in os.listdir(folder_path):
        if file.startswith('messages') and file.endswith('.html'):
            html_files.append(os.path.join(folder_path, file))
    
    if not html_files:
        print(f"错误: 在 {folder_path} 中找不到任何messages*.html文件")
        return {}
    
    print(f"找到 {len(html_files)} 个HTML文件: {[os.path.basename(f) for f in html_files]}")
    
    image_text_mapping = {}
    
    # 处理每个HTML文件
    for html_path in html_files:
        print(f"正在处理: {os.path.basename(html_path)}")
        
        try:
            # 读取HTML文件
            with open(html_path, 'r', encoding='utf-8') as f:
                html_content = f.read()
            
            # 解析HTML
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # 提取所有消息
            messages = soup.find_all('div', class_='message')
            
            for message in messages:
                # 查找图片链接
                photo_wrap = message.find('a', class_='photo_wrap')
                if photo_wrap and photo_wrap.get('href'):
                    img_tag = photo_wrap.find('img')
                    if img_tag and img_tag.get('src'):
                        # 获取缩略图路径
                        thumb_src = img_tag.get('src')
                        # 获取原图路径
                        full_img_src = photo_wrap.get('href')
                        
                        # 提取图片文件名
                        img_filename = os.path.basename(full_img_src)
                        
                        # 查找对应的文本内容
                        text_div = message.find('div', class_='text')
                        if text_div:
                            # 获取纯文本内容
                            text_content = text_div.get_text(strip=True)
                            # 移除多余的空白字符
                            text_content = re.sub(r'\s+', ' ', text_content)
                            # 移除开头的空白
                            text_content = text_content.strip()
                            
                            # 提取所有链接信息，包括百度和夸克链接
                            links_info = []
                            for a_tag in text_div.find_all('a', href=True):
                                href = a_tag.get('href')
                                link_text = a_tag.get_text(strip=True)
                                if href and link_text:
                                    # 保留完整的链接信息，包括特殊字符
                                    links_info.append(f"{link_text}: {href}")
                            
                            # 提取所有标签信息
                            tags_info = []
                            for a_tag in text_div.find_all('a', onclick=True):
                                onclick = a_tag.get('onclick', '')
                                # 使用正则表达式提取标签名，处理HTML实体编码
                                tag_match = re.search(r'ShowHashtag\("([^&]+)"\)', onclick)
                                if tag_match:
                                    tag_name = tag_match.group(1)
                                    tags_info.append(f"#{tag_name}")
                            
                            # 添加链接和标签信息到文本内容后
                            if links_info:
                                text_content += "\n\n链接信息:\n" + "\n".join(links_info)
                            if tags_info:
                                text_content += "\n\n标签:\n" + " ".join(tags_info)
                            
                            # 如果图片文件名已存在，合并文本内容
                            if img_filename in image_text_mapping:
                                image_text_mapping[img_filename] += f"\n\n--- 来自 {os.path.basename(html_path)} ---\n{text_content}"
                            else:
                                image_text_mapping[img_filename] = text_content
        except Exception as e:
            print(f"处理文件 {os.path.basename(html_path)} 时出错: {e}")
            continue
    
    return image_text_mapping

def generate_txt_files(folder_path, image_text_mapping):
    """
    为每个图片生成对应的TXT文件
    
    Args:
        folder_path: 包含photos目录的文件夹路径
        image_text_mapping: 图片文件名到文本内容的映射
    """
    photos_path = os.path.join(folder_path, 'photos')
    
    if not os.path.exists(photos_path):
        # 如果photos目录不存在，创建它并生成虚拟的TXT文件
        print(f"创建目录: {photos_path}")
        os.makedirs(photos_path, exist_ok=True)
        
        # 为每个映射的图片文件生成TXT文件
        for img_filename, text_content in image_text_mapping.items():
            # 生成TXT文件路径
            txt_filename = os.path.splitext(img_filename)[0] + '.txt'
            txt_filepath = os.path.join(photos_path, txt_filename)
            
            # 写入TXT文件
            with open(txt_filepath, 'w', encoding='utf-8') as f:
                f.write(text_content)
            
            print(f"已生成: {txt_filename}")
        return
    
    # 遍历photos目录中的所有图片文件
    for filename in os.listdir(photos_path):
        if filename.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.bmp')):
            # 获取对应的文本内容
            text_content = image_text_mapping.get(filename, "")
            
            # 生成TXT文件路径
            txt_filename = os.path.splitext(filename)[0] + '.txt'
            txt_filepath = os.path.join(photos_path, txt_filename)
            
            # 写入TXT文件
            with open(txt_filepath, 'w', encoding='utf-8') as f:
                f.write(text_content)
            
            print(f"已生成: {txt_filename}")

def process_folder(folder_path):
    """
    处理指定文件夹中的HTML和图片
    
    Args:
        folder_path: 要处理的文件夹路径
    """
    print(f"正在处理文件夹: {folder_path}")
    
    # 提取图片与文本的映射关系
    image_text_mapping = extract_image_text_mapping(folder_path)
    
    if not image_text_mapping:
        print("没有找到任何图片与文本的映射关系")
        return
    
    print(f"总共找到 {len(image_text_mapping)} 个图片与文本的映射关系")
    
    # 生成TXT文件
    generate_txt_files(folder_path, image_text_mapping)
    
    print("处理完成!")

def main():
    """
    主函数
    """
    import sys
    
    if len(sys.argv) < 2:
        print("使用方法: python aliyupanpan_format.py <文件夹路径>")
        print("示例: python aliyupanpan_format.py /path/to/aliyunpan_folder")
        print("或者: python aliyupanpan_format.py \"C:\\path\\to\\aliyunpan_folder\"")
        return
    
    folder_path = sys.argv[1]
    
    # 处理路径中的引号
    if folder_path.startswith('"') and folder_path.endswith('"'):
        folder_path = folder_path[1:-1]
    elif folder_path.startswith("'") and folder_path.endswith("'"):
        folder_path = folder_path[1:-1]
    
    if not os.path.exists(folder_path):
        print(f"错误: 文件夹 {folder_path} 不存在")
        return
    
    if not os.path.isdir(folder_path):
        print(f"错误: {folder_path} 不是一个文件夹")
        return
    
    # 检查文件夹内容
    print(f"文件夹内容: {os.listdir(folder_path)}")
    
    process_folder(folder_path)

if __name__ == "__main__":
    main()
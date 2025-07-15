setInterval(check_if_img_loaded, 2000)


function check_if_img_loaded(params) {
    var images = document.images;
    var filteredImages = Array.prototype.filter.call(images, function (img) {
        return img.className.includes("static/img");
    });
    if (filteredImages[0].className != filteredImages[0].name) {
        console.log("初始化...");
        console.log('classname: ', filteredImages[0].className)
        console.log('name: ', filteredImages[0].name)
        preload(filteredImages, 0)
    }
}


function preload(images, index) {
    console.log('preload image...' + index)
    index = index || 0;
    if (images && images.length > index) {
        var img = images[index];
        var src = images[index].className;
        if (index == 0) {
            for (var i = index + 1; i < images.length; i++) {
                console.log('reset image...' + i)
                images[i].onload = null
                images[i].src = 'assets/Russian-Cute-Sexy-Girl.jpg';
            }
        }
        img.onload = function () {
            preload(images, index + 1);
        };
        img.onerror = function () {
            console.log('图片载入失败了...', img)
            // // 初始化或增加加载失败的次数
            // if (img.dataset.loadFailures) {
            //     img.dataset.loadFailures++;
            // } else {
            //     img.dataset.loadFailures = 1;
            // }
            // if (img.dataset.loadFailures > 5) {
            //     console.log('图片失败次数过多，停止重试...')
            //     return 
            // } else {
            //     console.log('已经失败次数...' + img.dataset.loadFailures)
            // }
            img.src = 'assets/load_fail_cat.png';
            preload(images, index + 1);
            // console.log('图片已替换，等待重载入...')
            // setTimeout(function () {
            //     img.onload = null;
            //     img.src = src;
            // }, 10000);
        }
        img.src = src;
        img.name = src;
    } else {
        console.log('所有图片加载完成');
        dash_clientside.set_props("data_update_img_path_list", { data: Date.now() })
    }
}

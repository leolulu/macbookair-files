(function () {
    "use strict";

    if (window.__imageViewerInitialized) {
        return;
    }
    window.__imageViewerInitialized = true;

    var viewerState = {
        links: [],
        index: -1,
        previousFocus: null,
        zoomMode: "fit",
        lastPointerX: null,
        lastPointerY: null
    };

    function getViewerElements() {
        return {
            viewer: document.getElementById("image_viewer"),
            image: document.getElementById("image_viewer_image"),
            previous: document.getElementById("image_viewer_previous"),
            next: document.getElementById("image_viewer_next"),
            previousZone: document.getElementById("image_viewer_previous_zone"),
            nextZone: document.getElementById("image_viewer_next_zone")
        };
    }

    function isVisibleImageLink(link) {
        var image = link.querySelector("img");
        if (!image) {
            return false;
        }

        var style = window.getComputedStyle(image);
        return style.display !== "none"
            && style.visibility !== "hidden"
            && image.getClientRects().length > 0;
    }

    function collectVisibleImageLinks() {
        return Array.prototype.filter.call(
            document.querySelectorAll("#container a.image-viewer-link"),
            isVisibleImageLink
        );
    }

    function getFitMetrics(image) {
        if (!image || !image.naturalWidth || !image.naturalHeight) {
            return null;
        }

        var scale = Math.min(
            window.innerWidth / image.naturalWidth,
            window.innerHeight / image.naturalHeight
        );
        var width = image.naturalWidth * scale;
        var height = image.naturalHeight * scale;

        return {
            scale: scale,
            width: width,
            height: height,
            left: (window.innerWidth - width) / 2,
            top: (window.innerHeight - height) / 2
        };
    }

    function hasZoomDifference(image, metrics) {
        return Boolean(
            image
            && metrics
            && (
                Math.abs(metrics.width - image.naturalWidth) > 0.5
                || Math.abs(metrics.height - image.naturalHeight) > 0.5
            )
        );
    }

    function clearImageLayout(image) {
        ["width", "height", "left", "top"].forEach(function (property) {
            image.style.removeProperty(property);
        });
    }

    function clearPointerFeedback(elements) {
        if (!elements.viewer) {
            return;
        }

        elements.viewer.classList.remove("can-zoom-in", "can-zoom-out");
        if (elements.previousZone) {
            elements.previousZone.classList.remove("is-active");
        }
        if (elements.nextZone) {
            elements.nextZone.classList.remove("is-active");
        }
    }

    function resetImageZoom(elements) {
        viewerState.zoomMode = "fit";
        elements.viewer.classList.remove("is-original-size");
        clearImageLayout(elements.image);
        elements.viewer.scrollLeft = 0;
        elements.viewer.scrollTop = 0;
        clearPointerFeedback(elements);
    }

    function updateLoadedImageMetrics() {
        var elements = getViewerElements();
        if (!elements.viewer || !elements.image || !isViewerOpen()) {
            return;
        }

        var metrics = getFitMetrics(elements.image);
        if (!metrics) {
            return;
        }

        if (viewerState.lastPointerX !== null && viewerState.lastPointerY !== null) {
            updatePointerFeedback(viewerState.lastPointerX, viewerState.lastPointerY);
        }
    }

    function renderCurrentImage() {
        var elements = getViewerElements();
        var link = viewerState.links[viewerState.index];
        if (!elements.viewer || !elements.image || !elements.previous || !elements.next || !link) {
            return;
        }

        var sourceImage = link.querySelector("img");
        resetImageZoom(elements);
        elements.image.onload = updateLoadedImageMetrics;
        elements.image.src = link.href;
        elements.image.alt = sourceImage ? sourceImage.alt : "";
        if (elements.image.complete && elements.image.naturalWidth) {
            updateLoadedImageMetrics();
        }

        var atFirstImage = viewerState.index === 0;
        var atLastImage = viewerState.index === viewerState.links.length - 1;
        elements.previous.disabled = atFirstImage;
        elements.next.disabled = atLastImage;
        elements.previous.classList.toggle("is-unavailable", atFirstImage);
        elements.next.classList.toggle("is-unavailable", atLastImage);
    }

    function openViewer(link) {
        var elements = getViewerElements();
        if (!elements.viewer || !elements.image) {
            return;
        }

        viewerState.links = collectVisibleImageLinks();
        viewerState.index = viewerState.links.indexOf(link);
        if (viewerState.index < 0) {
            return;
        }

        viewerState.previousFocus = document.activeElement;
        elements.viewer.classList.add("is-open");
        elements.viewer.setAttribute("aria-hidden", "false");
        document.body.classList.add("image-viewer-open");
        renderCurrentImage();
    }

    function closeViewer() {
        var elements = getViewerElements();
        if (!elements.viewer || !elements.viewer.classList.contains("is-open")) {
            return;
        }

        elements.viewer.classList.remove("is-open");
        elements.viewer.setAttribute("aria-hidden", "true");
        document.body.classList.remove("image-viewer-open");
        resetImageZoom(elements);
        elements.image.onload = null;
        elements.image.removeAttribute("src");

        if (viewerState.previousFocus && typeof viewerState.previousFocus.focus === "function") {
            viewerState.previousFocus.focus();
        }
        viewerState.links = [];
        viewerState.index = -1;
        viewerState.previousFocus = null;
        viewerState.lastPointerX = null;
        viewerState.lastPointerY = null;
    }

    function moveViewer(direction) {
        var nextIndex = viewerState.index + direction;
        if (nextIndex < 0 || nextIndex >= viewerState.links.length) {
            return;
        }

        viewerState.index = nextIndex;
        renderCurrentImage();
    }

    function isViewerOpen() {
        var viewer = document.getElementById("image_viewer");
        return Boolean(viewer && viewer.classList.contains("is-open"));
    }

    function getDisplayedImageRect(elements) {
        if (viewerState.zoomMode === "original") {
            return elements.image.getBoundingClientRect();
        }

        var metrics = getFitMetrics(elements.image);
        if (!metrics) {
            return null;
        }

        return {
            left: metrics.left,
            top: metrics.top,
            right: metrics.left + metrics.width,
            bottom: metrics.top + metrics.height,
            width: metrics.width,
            height: metrics.height
        };
    }

    function isPointInsideDisplayedImage(elements, clientX, clientY) {
        var rect = getDisplayedImageRect(elements);
        return Boolean(
            rect
            && clientX >= rect.left
            && clientX <= rect.right
            && clientY >= rect.top
            && clientY <= rect.bottom
        );
    }

    function isScrollbarInteraction(elements, clientX, clientY) {
        return clientX >= elements.viewer.clientWidth || clientY >= elements.viewer.clientHeight;
    }

    function applyOriginalImageLayout(elements) {
        var image = elements.image;
        var left = Math.max(0, (window.innerWidth - image.naturalWidth) / 2);
        var top = Math.max(0, (window.innerHeight - image.naturalHeight) / 2);

        elements.viewer.classList.add("is-original-size");
        image.style.width = image.naturalWidth + "px";
        image.style.height = image.naturalHeight + "px";
        image.style.left = left + "px";
        image.style.top = top + "px";

        return {
            left: left,
            top: top
        };
    }

    function showOriginalSize(elements, clientX, clientY) {
        var metrics = getFitMetrics(elements.image);
        if (!hasZoomDifference(elements.image, metrics)) {
            return;
        }

        var naturalX = Math.max(
            0,
            Math.min(elements.image.naturalWidth, (clientX - metrics.left) / metrics.scale)
        );
        var naturalY = Math.max(
            0,
            Math.min(elements.image.naturalHeight, (clientY - metrics.top) / metrics.scale)
        );
        var position = applyOriginalImageLayout(elements);
        var scrollLeft = position.left + naturalX - clientX;
        var scrollTop = position.top + naturalY - clientY;

        viewerState.zoomMode = "original";
        elements.viewer.scrollLeft = scrollLeft;
        elements.viewer.scrollTop = scrollTop;
        window.requestAnimationFrame(function () {
            if (isViewerOpen() && viewerState.zoomMode === "original") {
                elements.viewer.scrollLeft = scrollLeft;
                elements.viewer.scrollTop = scrollTop;
            }
        });
    }

    function showFitSize(elements) {
        viewerState.zoomMode = "fit";
        elements.viewer.classList.remove("is-original-size");
        clearImageLayout(elements.image);
        elements.viewer.scrollLeft = 0;
        elements.viewer.scrollTop = 0;
    }

    function toggleImageZoom(elements, clientX, clientY) {
        var metrics = getFitMetrics(elements.image);
        if (!hasZoomDifference(elements.image, metrics)) {
            return;
        }

        if (viewerState.zoomMode === "fit") {
            showOriginalSize(elements, clientX, clientY);
        } else {
            showFitSize(elements);
        }
        updatePointerFeedback(clientX, clientY);
    }

    function updatePointerFeedback(clientX, clientY) {
        var elements = getViewerElements();
        if (!elements.viewer || !elements.image || !isViewerOpen()) {
            return;
        }

        viewerState.lastPointerX = clientX;
        viewerState.lastPointerY = clientY;

        if (elements.previousZone) {
            var previousZoneRect = elements.previousZone.getBoundingClientRect();
            elements.previousZone.classList.toggle("is-active", clientX <= previousZoneRect.right);
        }
        if (elements.nextZone) {
            var nextZoneRect = elements.nextZone.getBoundingClientRect();
            elements.nextZone.classList.toggle("is-active", clientX >= nextZoneRect.left);
        }

        elements.viewer.classList.remove("can-zoom-in", "can-zoom-out");
        var metrics = getFitMetrics(elements.image);
        if (
            isScrollbarInteraction(elements, clientX, clientY)
            || !isPointInsideDisplayedImage(elements, clientX, clientY)
            || !hasZoomDifference(elements.image, metrics)
        ) {
            return;
        }

        var nextActionIsZoomIn = viewerState.zoomMode === "fit"
            ? metrics.scale < 1
            : metrics.scale > 1;
        elements.viewer.classList.add(nextActionIsZoomIn ? "can-zoom-in" : "can-zoom-out");
    }

    document.addEventListener("click", function (event) {
        var closeButton = event.target.closest("#image_viewer_close");
        if (closeButton) {
            event.preventDefault();
            closeViewer();
            return;
        }

        var previousButton = event.target.closest("#image_viewer_previous");
        if (previousButton) {
            event.preventDefault();
            moveViewer(-1);
            return;
        }

        var nextButton = event.target.closest("#image_viewer_next");
        if (nextButton) {
            event.preventDefault();
            moveViewer(1);
            return;
        }

        if (isViewerOpen()) {
            var elements = getViewerElements();
            if (
                event.button !== 0
                || !elements.viewer
                || !elements.viewer.contains(event.target)
                || isScrollbarInteraction(elements, event.clientX, event.clientY)
            ) {
                return;
            }

            event.preventDefault();
            if (isPointInsideDisplayedImage(elements, event.clientX, event.clientY)) {
                toggleImageZoom(elements, event.clientX, event.clientY);
            } else {
                closeViewer();
            }
            return;
        }

        var link = event.target.closest("#container a.image-viewer-link");
        if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }

        event.preventDefault();
        openViewer(link);
    });

    document.addEventListener("contextmenu", function (event) {
        if (!isViewerOpen() || event.button !== 2) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        closeViewer();
    }, true);

    document.addEventListener("keydown", function (event) {
        if (!isViewerOpen()) {
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            closeViewer();
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            moveViewer(-1);
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            moveViewer(1);
        }
    });

    document.addEventListener("mousemove", function (event) {
        if (isViewerOpen()) {
            updatePointerFeedback(event.clientX, event.clientY);
        }
    });

    document.addEventListener("mouseout", function (event) {
        if (isViewerOpen() && !event.relatedTarget) {
            var elements = getViewerElements();
            viewerState.lastPointerX = null;
            viewerState.lastPointerY = null;
            clearPointerFeedback(elements);
        }
    });

    window.addEventListener("resize", function () {
        if (!isViewerOpen()) {
            return;
        }

        var elements = getViewerElements();
        if (viewerState.zoomMode === "original") {
            applyOriginalImageLayout(elements);
        } else {
            updateLoadedImageMetrics();
        }

        if (viewerState.lastPointerX !== null && viewerState.lastPointerY !== null) {
            updatePointerFeedback(viewerState.lastPointerX, viewerState.lastPointerY);
        }
    });
})();

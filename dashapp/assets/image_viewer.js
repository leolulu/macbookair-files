(function () {
    "use strict";

    if (window.__imageViewerInitialized) {
        return;
    }
    window.__imageViewerInitialized = true;

    var viewerState = {
        links: [],
        index: -1,
        previousFocus: null
    };

    function getViewerElements() {
        return {
            viewer: document.getElementById("image_viewer"),
            image: document.getElementById("image_viewer_image"),
            previous: document.getElementById("image_viewer_previous"),
            next: document.getElementById("image_viewer_next")
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

    function renderCurrentImage() {
        var elements = getViewerElements();
        var link = viewerState.links[viewerState.index];
        if (!elements.viewer || !elements.image || !elements.previous || !elements.next || !link) {
            return;
        }

        var sourceImage = link.querySelector("img");
        elements.image.src = link.href;
        elements.image.alt = sourceImage ? sourceImage.alt : "";

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
        elements.image.removeAttribute("src");

        if (viewerState.previousFocus && typeof viewerState.previousFocus.focus === "function") {
            viewerState.previousFocus.focus();
        }
        viewerState.links = [];
        viewerState.index = -1;
        viewerState.previousFocus = null;
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

        var link = event.target.closest("#container a.image-viewer-link");
        if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }

        event.preventDefault();
        openViewer(link);
    });

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
})();

def parse_line_and_words_boundary(json_data):
    line_coordinates = []
    words_coordinates = []

    for line in json_data[0]["lines"]:
        line_coordinates.append(line["boundingPolygon"])
        for word in line["words"]:
            words_coordinates.append(word["boundingPolygon"])

    return line_coordinates, words_coordinates

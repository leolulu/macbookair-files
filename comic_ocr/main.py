import json

from annotate_rec import draw_quadrilateral
from parse_azure_ocr_result import parse_line_and_words_boundary




data = '''[
  {
    "lines": [
      {
        "text": "RUKIA! I'VE CAME",
        "boundingPolygon": [
          {
            "x": 129,
            "y": 21
          },
          {
            "x": 261,
            "y": 21
          },
          {
            "x": 261,
            "y": 43
          },
          {
            "x": 129,
            "y": 44
          }
        ],
        "words": [
          {
            "text": "RUKIA!",
            "boundingPolygon": [
              {
                "x": 131,
                "y": 23
              },
              {
                "x": 177,
                "y": 22
              },
              {
                "x": 177,
                "y": 43
              },
              {
                "x": 130,
                "y": 43
              }
            ],
            "confidence": 0.966
          },
          {
            "text": "I'VE",
            "boundingPolygon": [
              {
                "x": 181,
                "y": 22
              },
              {
                "x": 210,
                "y": 22
              },
              {
                "x": 210,
                "y": 44
              },
              {
                "x": 181,
                "y": 43
              }
            ],
            "confidence": 0.963
          },
          {
            "text": "CAME",
            "boundingPolygon": [
              {
                "x": 215,
                "y": 22
              },
              {
                "x": 260,
                "y": 21
              },
              {
                "x": 259,
                "y": 44
              },
              {
                "x": 215,
                "y": 44
              }
            ],
            "confidence": 0.99
          }
        ]
      },
      {
        "text": "ORIHIME!",
        "boundingPolygon": [
          {
            "x": 638,
            "y": 8
          },
          {
            "x": 689,
            "y": 8
          },
          {
            "x": 689,
            "y": 23
          },
          {
            "x": 638,
            "y": 24
          }
        ],
        "words": [
          {
            "text": "ORIHIME!",
            "boundingPolygon": [
              {
                "x": 639,
                "y": 9
              },
              {
                "x": 690,
                "y": 9
              },
              {
                "x": 689,
                "y": 24
              },
              {
                "x": 638,
                "y": 24
              }
            ],
            "confidence": 0.959
          }
        ]
      },
      {
        "text": "01",
        "boundingPolygon": [
          {
            "x": 814,
            "y": 2
          },
          {
            "x": 844,
            "y": 2
          },
          {
            "x": 844,
            "y": 27
          },
          {
            "x": 814,
            "y": 27
          }
        ],
        "words": [
          {
            "text": "01",
            "boundingPolygon": [
              {
                "x": 816,
                "y": 2
              },
              {
                "x": 844,
                "y": 2
              },
              {
                "x": 844,
                "y": 27
              },
              {
                "x": 816,
                "y": 27
              }
            ],
            "confidence": 0.994
          }
        ]
      },
      {
        "text": "THANK GOODNESS! I'M NOT POWERFUL",
        "boundingPolygon": [
          {
            "x": 554,
            "y": 27
          },
          {
            "x": 770,
            "y": 27
          },
          {
            "x": 770,
            "y": 43
          },
          {
            "x": 554,
            "y": 43
          }
        ],
        "words": [
          {
            "text": "THANK",
            "boundingPolygon": [
              {
                "x": 555,
                "y": 28
              },
              {
                "x": 589,
                "y": 28
              },
              {
                "x": 588,
                "y": 44
              },
              {
                "x": 555,
                "y": 43
              }
            ],
            "confidence": 0.996
          },
          {
            "text": "GOODNESS!",
            "boundingPolygon": [
              {
                "x": 592,
                "y": 28
              },
              {
                "x": 658,
                "y": 28
              },
              {
                "x": 657,
                "y": 44
              },
              {
                "x": 592,
                "y": 44
              }
            ],
            "confidence": 0.98
          },
          {
            "text": "I'M",
            "boundingPolygon": [
              {
                "x": 661,
                "y": 28
              },
              {
                "x": 678,
                "y": 28
              },
              {
                "x": 678,
                "y": 44
              },
              {
                "x": 660,
                "y": 44
              }
            ],
            "confidence": 0.992
          },
          {
            "text": "NOT",
            "boundingPolygon": [
              {
                "x": 682,
                "y": 28
              },
              {
                "x": 705,
                "y": 27
              },
              {
                "x": 705,
                "y": 44
              },
              {
                "x": 682,
                "y": 44
              }
            ],
            "confidence": 0.996
          },
          {
            "text": "POWERFUL",
            "boundingPolygon": [
              {
                "x": 708,
                "y": 27
              },
              {
                "x": 770,
                "y": 27
              },
              {
                "x": 770,
                "y": 44
              },
              {
                "x": 708,
                "y": 44
              }
            ],
            "confidence": 0.978
          }
        ]
      },
      {
        "text": "TO SAVE YOU!",
        "boundingPolygon": [
          {
            "x": 139,
            "y": 45
          },
          {
            "x": 253,
            "y": 45
          },
          {
            "x": 253,
            "y": 71
          },
          {
            "x": 139,
            "y": 71
          }
        ],
        "words": [
          {
            "text": "TO",
            "boundingPolygon": [
              {
                "x": 141,
                "y": 46
              },
              {
                "x": 165,
                "y": 46
              },
              {
                "x": 165,
                "y": 71
              },
              {
                "x": 140,
                "y": 72
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "SAVE",
            "boundingPolygon": [
              {
                "x": 171,
                "y": 46
              },
              {
                "x": 209,
                "y": 46
              },
              {
                "x": 209,
                "y": 71
              },
              {
                "x": 170,
                "y": 71
              }
            ],
            "confidence": 0.992
          },
          {
            "text": "YOU!",
            "boundingPolygon": [
              {
                "x": 214,
                "y": 46
              },
              {
                "x": 253,
                "y": 47
              },
              {
                "x": 253,
                "y": 71
              },
              {
                "x": 214,
                "y": 71
              }
            ],
            "confidence": 0.889
          }
        ]
      },
      {
        "text": "ENOUGH TO DEFEAT THESE FUCKERS",
        "boundingPolygon": [
          {
            "x": 556,
            "y": 46
          },
          {
            "x": 769,
            "y": 46
          },
          {
            "x": 769,
            "y": 62
          },
          {
            "x": 556,
            "y": 63
          }
        ],
        "words": [
          {
            "text": "ENOUGH",
            "boundingPolygon": [
              {
                "x": 556,
                "y": 46
              },
              {
                "x": 603,
                "y": 47
              },
              {
                "x": 603,
                "y": 63
              },
              {
                "x": 556,
                "y": 64
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "TO",
            "boundingPolygon": [
              {
                "x": 607,
                "y": 47
              },
              {
                "x": 622,
                "y": 47
              },
              {
                "x": 622,
                "y": 63
              },
              {
                "x": 607,
                "y": 63
              }
            ],
            "confidence": 0.996
          },
          {
            "text": "DEFEAT",
            "boundingPolygon": [
              {
                "x": 627,
                "y": 47
              },
              {
                "x": 673,
                "y": 47
              },
              {
                "x": 673,
                "y": 63
              },
              {
                "x": 627,
                "y": 63
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "THESE",
            "boundingPolygon": [
              {
                "x": 677,
                "y": 47
              },
              {
                "x": 712,
                "y": 47
              },
              {
                "x": 712,
                "y": 63
              },
              {
                "x": 677,
                "y": 63
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "FUCKERS",
            "boundingPolygon": [
              {
                "x": 716,
                "y": 47
              },
              {
                "x": 769,
                "y": 46
              },
              {
                "x": 769,
                "y": 63
              },
              {
                "x": 716,
                "y": 63
              }
            ],
            "confidence": 0.993
          }
        ]
      },
      {
        "text": "SO I HAD TO DISTRACT THEM",
        "boundingPolygon": [
          {
            "x": 579,
            "y": 65
          },
          {
            "x": 747,
            "y": 65
          },
          {
            "x": 747,
            "y": 81
          },
          {
            "x": 579,
            "y": 81
          }
        ],
        "words": [
          {
            "text": "SO",
            "boundingPolygon": [
              {
                "x": 579,
                "y": 66
              },
              {
                "x": 594,
                "y": 66
              },
              {
                "x": 594,
                "y": 82
              },
              {
                "x": 580,
                "y": 82
              }
            ],
            "confidence": 0.888
          },
          {
            "text": "I",
            "boundingPolygon": [
              {
                "x": 597,
                "y": 66
              },
              {
                "x": 602,
                "y": 66
              },
              {
                "x": 602,
                "y": 82
              },
              {
                "x": 598,
                "y": 82
              }
            ],
            "confidence": 0.581
          },
          {
            "text": "HAD",
            "boundingPolygon": [
              {
                "x": 605,
                "y": 66
              },
              {
                "x": 629,
                "y": 66
              },
              {
                "x": 629,
                "y": 82
              },
              {
                "x": 605,
                "y": 82
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "TO",
            "boundingPolygon": [
              {
                "x": 633,
                "y": 66
              },
              {
                "x": 648,
                "y": 66
              },
              {
                "x": 648,
                "y": 82
              },
              {
                "x": 634,
                "y": 82
              }
            ],
            "confidence": 0.997
          },
          {
            "text": "DISTRACT",
            "boundingPolygon": [
              {
                "x": 653,
                "y": 66
              },
              {
                "x": 711,
                "y": 66
              },
              {
                "x": 711,
                "y": 82
              },
              {
                "x": 653,
                "y": 82
              }
            ],
            "confidence": 0.958
          },
          {
            "text": "THEM",
            "boundingPolygon": [
              {
                "x": 714,
                "y": 66
              },
              {
                "x": 743,
                "y": 66
              },
              {
                "x": 742,
                "y": 82
              },
              {
                "x": 714,
                "y": 82
              }
            ],
            "confidence": 0.989
          }
        ]
      },
      {
        "text": "WITH MY ASS!",
        "boundingPolygon": [
          {
            "x": 623,
            "y": 85
          },
          {
            "x": 702,
            "y": 85
          },
          {
            "x": 702,
            "y": 101
          },
          {
            "x": 623,
            "y": 101
          }
        ],
        "words": [
          {
            "text": "WITH",
            "boundingPolygon": [
              {
                "x": 624,
                "y": 86
              },
              {
                "x": 651,
                "y": 86
              },
              {
                "x": 650,
                "y": 101
              },
              {
                "x": 624,
                "y": 101
              }
            ],
            "confidence": 0.988
          },
          {
            "text": "MY",
            "boundingPolygon": [
              {
                "x": 654,
                "y": 86
              },
              {
                "x": 672,
                "y": 85
              },
              {
                "x": 672,
                "y": 101
              },
              {
                "x": 654,
                "y": 101
              }
            ],
            "confidence": 0.942
          },
          {
            "text": "ASS!",
            "boundingPolygon": [
              {
                "x": 676,
                "y": 85
              },
              {
                "x": 702,
                "y": 85
              },
              {
                "x": 701,
                "y": 102
              },
              {
                "x": 676,
                "y": 101
              }
            ],
            "confidence": 0.989
          }
        ]
      },
      {
        "text": "HUH ?!?",
        "boundingPolygon": [
          {
            "x": 789,
            "y": 135
          },
          {
            "x": 839,
            "y": 133
          },
          {
            "x": 839,
            "y": 149
          },
          {
            "x": 789,
            "y": 151
          }
        ],
        "words": [
          {
            "text": "HUH",
            "boundingPolygon": [
              {
                "x": 789,
                "y": 135
              },
              {
                "x": 815,
                "y": 135
              },
              {
                "x": 815,
                "y": 151
              },
              {
                "x": 789,
                "y": 151
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "?!?",
            "boundingPolygon": [
              {
                "x": 819,
                "y": 135
              },
              {
                "x": 839,
                "y": 134
              },
              {
                "x": 838,
                "y": 150
              },
              {
                "x": 818,
                "y": 151
              }
            ],
            "confidence": 0.822
          }
        ]
      },
      {
        "text": "WHY ...?",
        "boundingPolygon": [
          {
            "x": 790,
            "y": 154
          },
          {
            "x": 838,
            "y": 153
          },
          {
            "x": 839,
            "y": 168
          },
          {
            "x": 790,
            "y": 169
          }
        ],
        "words": [
          {
            "text": "WHY",
            "boundingPolygon": [
              {
                "x": 791,
                "y": 155
              },
              {
                "x": 816,
                "y": 154
              },
              {
                "x": 817,
                "y": 169
              },
              {
                "x": 791,
                "y": 169
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "...?",
            "boundingPolygon": [
              {
                "x": 819,
                "y": 154
              },
              {
                "x": 838,
                "y": 154
              },
              {
                "x": 839,
                "y": 168
              },
              {
                "x": 820,
                "y": 169
              }
            ],
            "confidence": 0.878
          }
        ]
      },
      {
        "text": "W-WHAT!",
        "boundingPolygon": [
          {
            "x": 265,
            "y": 289
          },
          {
            "x": 337,
            "y": 289
          },
          {
            "x": 337,
            "y": 312
          },
          {
            "x": 265,
            "y": 312
          }
        ],
        "words": [
          {
            "text": "W-WHAT!",
            "boundingPolygon": [
              {
                "x": 266,
                "y": 290
              },
              {
                "x": 337,
                "y": 289
              },
              {
                "x": 337,
                "y": 313
              },
              {
                "x": 266,
                "y": 312
              }
            ],
            "confidence": 0.989
          }
        ]
      },
      {
        "text": "WHEN DID",
        "boundingPolygon": [
          {
            "x": 261,
            "y": 316
          },
          {
            "x": 341,
            "y": 316
          },
          {
            "x": 341,
            "y": 338
          },
          {
            "x": 261,
            "y": 339
          }
        ],
        "words": [
          {
            "text": "WHEN",
            "boundingPolygon": [
              {
                "x": 263,
                "y": 316
              },
              {
                "x": 306,
                "y": 317
              },
              {
                "x": 306,
                "y": 339
              },
              {
                "x": 262,
                "y": 339
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "DID",
            "boundingPolygon": [
              {
                "x": 311,
                "y": 317
              },
              {
                "x": 339,
                "y": 316
              },
              {
                "x": 338,
                "y": 339
              },
              {
                "x": 310,
                "y": 339
              }
            ],
            "confidence": 0.992
          }
        ]
      },
      {
        "text": "HE ?.",
        "boundingPolygon": [
          {
            "x": 281,
            "y": 340
          },
          {
            "x": 314,
            "y": 340
          },
          {
            "x": 315,
            "y": 365
          },
          {
            "x": 281,
            "y": 365
          }
        ],
        "words": [
          {
            "text": "HE",
            "boundingPolygon": [
              {
                "x": 281,
                "y": 340
              },
              {
                "x": 298,
                "y": 340
              },
              {
                "x": 298,
                "y": 365
              },
              {
                "x": 281,
                "y": 365
              }
            ],
            "confidence": 0.992
          },
          {
            "text": "?.",
            "boundingPolygon": [
              {
                "x": 303,
                "y": 340
              },
              {
                "x": 314,
                "y": 340
              },
              {
                "x": 314,
                "y": 365
              },
              {
                "x": 303,
                "y": 365
              }
            ],
            "confidence": 0.842
          }
        ]
      },
      {
        "text": "I'M SORRY ORIHIME ...",
        "boundingPolygon": [
          {
            "x": 648,
            "y": 447
          },
          {
            "x": 813,
            "y": 447
          },
          {
            "x": 814,
            "y": 465
          },
          {
            "x": 648,
            "y": 465
          }
        ],
        "words": [
          {
            "text": "I'M",
            "boundingPolygon": [
              {
                "x": 649,
                "y": 447
              },
              {
                "x": 666,
                "y": 448
              },
              {
                "x": 666,
                "y": 466
              },
              {
                "x": 649,
                "y": 466
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "SORRY",
            "boundingPolygon": [
              {
                "x": 678,
                "y": 448
              },
              {
                "x": 732,
                "y": 448
              },
              {
                "x": 732,
                "y": 465
              },
              {
                "x": 678,
                "y": 466
              }
            ],
            "confidence": 0.979
          },
          {
            "text": "ORIHIME",
            "boundingPolygon": [
              {
                "x": 739,
                "y": 448
              },
              {
                "x": 794,
                "y": 448
              },
              {
                "x": 793,
                "y": 465
              },
              {
                "x": 738,
                "y": 465
              }
            ],
            "confidence": 0.965
          },
          {
            "text": "...",
            "boundingPolygon": [
              {
                "x": 797,
                "y": 448
              },
              {
                "x": 813,
                "y": 447
              },
              {
                "x": 813,
                "y": 465
              },
              {
                "x": 797,
                "y": 465
              }
            ],
            "confidence": 0.993
          }
        ]
      },
      {
        "text": "BUT I CAN'T TAKE BOTH",
        "boundingPolygon": [
          {
            "x": 632,
            "y": 467
          },
          {
            "x": 828,
            "y": 467
          },
          {
            "x": 828,
            "y": 485
          },
          {
            "x": 632,
            "y": 485
          }
        ],
        "words": [
          {
            "text": "BUT",
            "boundingPolygon": [
              {
                "x": 633,
                "y": 468
              },
              {
                "x": 665,
                "y": 468
              },
              {
                "x": 664,
                "y": 486
              },
              {
                "x": 633,
                "y": 486
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "I",
            "boundingPolygon": [
              {
                "x": 668,
                "y": 468
              },
              {
                "x": 678,
                "y": 468
              },
              {
                "x": 678,
                "y": 486
              },
              {
                "x": 668,
                "y": 486
              }
            ],
            "confidence": 0.989
          },
          {
            "text": "CAN'T",
            "boundingPolygon": [
              {
                "x": 682,
                "y": 468
              },
              {
                "x": 730,
                "y": 469
              },
              {
                "x": 729,
                "y": 486
              },
              {
                "x": 682,
                "y": 486
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "TAKE",
            "boundingPolygon": [
              {
                "x": 736,
                "y": 469
              },
              {
                "x": 774,
                "y": 468
              },
              {
                "x": 774,
                "y": 486
              },
              {
                "x": 736,
                "y": 486
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "BOTH",
            "boundingPolygon": [
              {
                "x": 783,
                "y": 468
              },
              {
                "x": 825,
                "y": 468
              },
              {
                "x": 825,
                "y": 486
              },
              {
                "x": 783,
                "y": 486
              }
            ],
            "confidence": 0.989
          }
        ]
      },
      {
        "text": "WAIT, WAIT, WAIT, WAIT!",
        "boundingPolygon": [
          {
            "x": 370,
            "y": 491
          },
          {
            "x": 568,
            "y": 491
          },
          {
            "x": 568,
            "y": 508
          },
          {
            "x": 370,
            "y": 509
          }
        ],
        "words": [
          {
            "text": "WAIT,",
            "boundingPolygon": [
              {
                "x": 370,
                "y": 492
              },
              {
                "x": 416,
                "y": 492
              },
              {
                "x": 416,
                "y": 509
              },
              {
                "x": 370,
                "y": 509
              }
            ],
            "confidence": 0.989
          },
          {
            "text": "WAIT,",
            "boundingPolygon": [
              {
                "x": 420,
                "y": 492
              },
              {
                "x": 467,
                "y": 492
              },
              {
                "x": 467,
                "y": 509
              },
              {
                "x": 420,
                "y": 509
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "WAIT,",
            "boundingPolygon": [
              {
                "x": 470,
                "y": 492
              },
              {
                "x": 518,
                "y": 492
              },
              {
                "x": 517,
                "y": 509
              },
              {
                "x": 470,
                "y": 509
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "WAIT!",
            "boundingPolygon": [
              {
                "x": 521,
                "y": 492
              },
              {
                "x": 568,
                "y": 492
              },
              {
                "x": 568,
                "y": 509
              },
              {
                "x": 521,
                "y": 509
              }
            ],
            "confidence": 0.99
          }
        ]
      },
      {
        "text": "AT THE SAME TIME ... SO",
        "boundingPolygon": [
          {
            "x": 631,
            "y": 488
          },
          {
            "x": 830,
            "y": 487
          },
          {
            "x": 830,
            "y": 506
          },
          {
            "x": 631,
            "y": 507
          }
        ],
        "words": [
          {
            "text": "AT",
            "boundingPolygon": [
              {
                "x": 635,
                "y": 488
              },
              {
                "x": 655,
                "y": 489
              },
              {
                "x": 655,
                "y": 507
              },
              {
                "x": 635,
                "y": 507
              }
            ],
            "confidence": 0.996
          },
          {
            "text": "THE",
            "boundingPolygon": [
              {
                "x": 662,
                "y": 489
              },
              {
                "x": 691,
                "y": 489
              },
              {
                "x": 691,
                "y": 507
              },
              {
                "x": 661,
                "y": 507
              }
            ],
            "confidence": 0.998
          },
          {
            "text": "SAME",
            "boundingPolygon": [
              {
                "x": 698,
                "y": 489
              },
              {
                "x": 744,
                "y": 489
              },
              {
                "x": 744,
                "y": 507
              },
              {
                "x": 698,
                "y": 507
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "TIME",
            "boundingPolygon": [
              {
                "x": 751,
                "y": 489
              },
              {
                "x": 779,
                "y": 489
              },
              {
                "x": 778,
                "y": 507
              },
              {
                "x": 751,
                "y": 507
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "...",
            "boundingPolygon": [
              {
                "x": 782,
                "y": 488
              },
              {
                "x": 803,
                "y": 488
              },
              {
                "x": 803,
                "y": 507
              },
              {
                "x": 782,
                "y": 507
              }
            ],
            "confidence": 0.979
          },
          {
            "text": "SO",
            "boundingPolygon": [
              {
                "x": 807,
                "y": 488
              },
              {
                "x": 829,
                "y": 488
              },
              {
                "x": 829,
                "y": 507
              },
              {
                "x": 806,
                "y": 507
              }
            ],
            "confidence": 0.972
          }
        ]
      },
      {
        "text": "I DON'T KNOW ABOUT THIS ...",
        "boundingPolygon": [
          {
            "x": 354,
            "y": 511
          },
          {
            "x": 583,
            "y": 511
          },
          {
            "x": 583,
            "y": 528
          },
          {
            "x": 354,
            "y": 528
          }
        ],
        "words": [
          {
            "text": "I",
            "boundingPolygon": [
              {
                "x": 355,
                "y": 512
              },
              {
                "x": 362,
                "y": 512
              },
              {
                "x": 362,
                "y": 529
              },
              {
                "x": 355,
                "y": 529
              }
            ],
            "confidence": 0.849
          },
          {
            "text": "DON'T",
            "boundingPolygon": [
              {
                "x": 365,
                "y": 512
              },
              {
                "x": 414,
                "y": 511
              },
              {
                "x": 414,
                "y": 529
              },
              {
                "x": 365,
                "y": 529
              }
            ],
            "confidence": 0.993
          },
          {
            "text": "KNOW",
            "boundingPolygon": [
              {
                "x": 420,
                "y": 511
              },
              {
                "x": 462,
                "y": 511
              },
              {
                "x": 462,
                "y": 529
              },
              {
                "x": 420,
                "y": 529
              }
            ],
            "confidence": 0.992
          },
          {
            "text": "ABOUT",
            "boundingPolygon": [
              {
                "x": 477,
                "y": 511
              },
              {
                "x": 532,
                "y": 512
              },
              {
                "x": 532,
                "y": 529
              },
              {
                "x": 477,
                "y": 529
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "THIS",
            "boundingPolygon": [
              {
                "x": 540,
                "y": 512
              },
              {
                "x": 569,
                "y": 512
              },
              {
                "x": 569,
                "y": 529
              },
              {
                "x": 540,
                "y": 529
              }
            ],
            "confidence": 0.983
          },
          {
            "text": "...",
            "boundingPolygon": [
              {
                "x": 573,
                "y": 512
              },
              {
                "x": 584,
                "y": 513
              },
              {
                "x": 584,
                "y": 529
              },
              {
                "x": 573,
                "y": 529
              }
            ],
            "confidence": 0.959
          }
        ]
      },
      {
        "text": "TAKE CARE OF THE BIG",
        "boundingPolygon": [
          {
            "x": 631,
            "y": 508
          },
          {
            "x": 824,
            "y": 508
          },
          {
            "x": 824,
            "y": 526
          },
          {
            "x": 631,
            "y": 526
          }
        ],
        "words": [
          {
            "text": "TAKE",
            "boundingPolygon": [
              {
                "x": 632,
                "y": 509
              },
              {
                "x": 670,
                "y": 509
              },
              {
                "x": 670,
                "y": 527
              },
              {
                "x": 632,
                "y": 527
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "CARE",
            "boundingPolygon": [
              {
                "x": 679,
                "y": 509
              },
              {
                "x": 724,
                "y": 509
              },
              {
                "x": 724,
                "y": 527
              },
              {
                "x": 679,
                "y": 527
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "OF",
            "boundingPolygon": [
              {
                "x": 733,
                "y": 509
              },
              {
                "x": 752,
                "y": 509
              },
              {
                "x": 752,
                "y": 527
              },
              {
                "x": 733,
                "y": 527
              }
            ],
            "confidence": 0.999
          },
          {
            "text": "THE",
            "boundingPolygon": [
              {
                "x": 761,
                "y": 509
              },
              {
                "x": 790,
                "y": 509
              },
              {
                "x": 789,
                "y": 527
              },
              {
                "x": 761,
                "y": 527
              }
            ],
            "confidence": 0.999
          },
          {
            "text": "BIG",
            "boundingPolygon": [
              {
                "x": 796,
                "y": 509
              },
              {
                "x": 823,
                "y": 509
              },
              {
                "x": 822,
                "y": 527
              },
              {
                "x": 796,
                "y": 527
              }
            ],
            "confidence": 0.995
          }
        ]
      },
      {
        "text": "I'VE NEVER SEEN A COCK",
        "boundingPolygon": [
          {
            "x": 364,
            "y": 531
          },
          {
            "x": 575,
            "y": 530
          },
          {
            "x": 575,
            "y": 548
          },
          {
            "x": 364,
            "y": 548
          }
        ],
        "words": [
          {
            "text": "I'VE",
            "boundingPolygon": [
              {
                "x": 365,
                "y": 531
              },
              {
                "x": 389,
                "y": 531
              },
              {
                "x": 388,
                "y": 548
              },
              {
                "x": 364,
                "y": 548
              }
            ],
            "confidence": 0.98
          },
          {
            "text": "NEVER",
            "boundingPolygon": [
              {
                "x": 397,
                "y": 531
              },
              {
                "x": 450,
                "y": 531
              },
              {
                "x": 450,
                "y": 549
              },
              {
                "x": 397,
                "y": 548
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "SEEN",
            "boundingPolygon": [
              {
                "x": 459,
                "y": 531
              },
              {
                "x": 500,
                "y": 531
              },
              {
                "x": 500,
                "y": 549
              },
              {
                "x": 458,
                "y": 549
              }
            ],
            "confidence": 0.992
          },
          {
            "text": "A",
            "boundingPolygon": [
              {
                "x": 511,
                "y": 531
              },
              {
                "x": 521,
                "y": 531
              },
              {
                "x": 520,
                "y": 549
              },
              {
                "x": 511,
                "y": 549
              }
            ],
            "confidence": 0.996
          },
          {
            "text": "COCK",
            "boundingPolygon": [
              {
                "x": 527,
                "y": 531
              },
              {
                "x": 573,
                "y": 531
              },
              {
                "x": 573,
                "y": 548
              },
              {
                "x": 527,
                "y": 548
              }
            ],
            "confidence": 0.996
          }
        ]
      },
      {
        "text": "GUY FOR ME ...",
        "boundingPolygon": [
          {
            "x": 675,
            "y": 530
          },
          {
            "x": 787,
            "y": 530
          },
          {
            "x": 787,
            "y": 548
          },
          {
            "x": 675,
            "y": 547
          }
        ],
        "words": [
          {
            "text": "GUY",
            "boundingPolygon": [
              {
                "x": 676,
                "y": 531
              },
              {
                "x": 706,
                "y": 530
              },
              {
                "x": 706,
                "y": 548
              },
              {
                "x": 676,
                "y": 548
              }
            ],
            "confidence": 0.974
          },
          {
            "text": "FOR",
            "boundingPolygon": [
              {
                "x": 712,
                "y": 530
              },
              {
                "x": 745,
                "y": 530
              },
              {
                "x": 744,
                "y": 548
              },
              {
                "x": 712,
                "y": 548
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "ME",
            "boundingPolygon": [
              {
                "x": 753,
                "y": 530
              },
              {
                "x": 768,
                "y": 531
              },
              {
                "x": 768,
                "y": 548
              },
              {
                "x": 753,
                "y": 548
              }
            ],
            "confidence": 0.994
          },
          {
            "text": "...",
            "boundingPolygon": [
              {
                "x": 771,
                "y": 531
              },
              {
                "x": 786,
                "y": 531
              },
              {
                "x": 786,
                "y": 549
              },
              {
                "x": 771,
                "y": 548
              }
            ],
            "confidence": 0.992
          }
        ]
      },
      {
        "text": "THIS HUGE BEFORE ...",
        "boundingPolygon": [
          {
            "x": 381,
            "y": 550
          },
          {
            "x": 550,
            "y": 550
          },
          {
            "x": 550,
            "y": 568
          },
          {
            "x": 381,
            "y": 567
          }
        ],
        "words": [
          {
            "text": "THIS",
            "boundingPolygon": [
              {
                "x": 382,
                "y": 551
              },
              {
                "x": 417,
                "y": 550
              },
              {
                "x": 417,
                "y": 568
              },
              {
                "x": 382,
                "y": 568
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "HUGE",
            "boundingPolygon": [
              {
                "x": 421,
                "y": 550
              },
              {
                "x": 465,
                "y": 550
              },
              {
                "x": 465,
                "y": 568
              },
              {
                "x": 421,
                "y": 568
              }
            ],
            "confidence": 0.989
          },
          {
            "text": "BEFORE",
            "boundingPolygon": [
              {
                "x": 473,
                "y": 550
              },
              {
                "x": 531,
                "y": 551
              },
              {
                "x": 531,
                "y": 568
              },
              {
                "x": 473,
                "y": 568
              }
            ],
            "confidence": 0.995
          },
          {
            "text": "...",
            "boundingPolygon": [
              {
                "x": 535,
                "y": 551
              },
              {
                "x": 550,
                "y": 551
              },
              {
                "x": 550,
                "y": 569
              },
              {
                "x": 535,
                "y": 569
              }
            ],
            "confidence": 0.993
          }
        ]
      }
    ]
  }
]'''


data = json.loads(data)
line_coordinates, words_coordinates = parse_line_and_words_boundary(data)

# print(line_coordinates)
# print(words_coordinates)

# draw_quadrilateral(
#     r"C:\Users\sisplayer\Downloads\sample_5ef169b4127970d6a7cf89ff7069f520.jpg",
#     line_coordinates,
#     # words_coordinates
# )

data = []
for line in line_coordinates:
    for xy in line:
        data.append([xy['x'],-xy['y']])

import matplotlib.pyplot as plt

# Extract x and y coordinates for visualization
x_coords = [point[0] for point in data]
y_coords = [point[1] for point in data]

# Create a scatter plot
plt.scatter(x_coords, y_coords, color='blue')
plt.title('Visualization of 2D Data')
plt.xlabel('X Coordinates')
plt.ylabel('Y Coordinates')
plt.grid(True)
plt.show()
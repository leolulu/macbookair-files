import os
import shutil
import sys


def split_files(dir_path, num_files):
    files = os.listdir(dir_path)
    files = [os.path.join(dir_path, f) for f in files if os.path.isfile(os.path.join(dir_path, f))]
    files.sort()
    for idx, f in enumerate(files):
        group_id = idx // num_files
        new_file_path = os.path.join(dir_path, f"{group_id}")
        if not os.path.exists(new_file_path):
            os.mkdir(new_file_path)
        shutil.move(f, new_file_path)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Usage: python split_group_files.py <directory_path> <number_of_files_per_group>")

        dir_path = sys.argv[1]
        if not os.path.isdir(dir_path):
            raise ValueError(f"Error: '{dir_path}' is not a valid directory")

        num_files = int(sys.argv[2])
        if num_files <= 0:
            raise ValueError("Error: Number of files must be a positive integer")

        split_files(dir_path, num_files)
        print(f"Successfully split files in '{dir_path}' into groups of {num_files}")
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred: {str(e)}", file=sys.stderr)
        sys.exit(1)

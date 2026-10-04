#!/usr/bin/env python3
"""把批次报告写入已钉住的目录 fd，不沿可被替换的路径 rename。

生产调用：python3 ai-task-pinned-write.py <dir> <basename>  < content
自测：python3 ai-task-pinned-write.py --self-test
"""
import os
import stat
import sys
import tempfile


class PinError(Exception):
    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


def write_into(dirfd, basename, data):
    """只通过已打开的目录 fd 写文件，不按路径重新打开。"""
    if (not basename) or basename in ('.', '..') or os.sep in basename or (os.altsep and os.altsep in basename):
        raise PinError('非法报告文件名')
    tmp = f'.{basename}.{os.getpid()}.tmp'
    try:
        try:
            st = os.lstat(basename, dir_fd=dirfd)
        except FileNotFoundError:
            st = None
        if st is not None and stat.S_ISLNK(st.st_mode):
            raise PinError('拒绝写入符号链接报告文件', 3)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dirfd)
        try:
            view = data if isinstance(data, (bytes, bytearray)) else str(data).encode('utf-8')
            os.write(fd, view)
        finally:
            os.close(fd)
        try:
            st2 = os.lstat(basename, dir_fd=dirfd)
        except FileNotFoundError:
            st2 = None
        if st2 is not None and stat.S_ISLNK(st2.st_mode):
            raise PinError('目标在写入前变为符号链接', 3)
        os.rename(tmp, basename, src_dir_fd=dirfd, dst_dir_fd=dirfd)
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp, dir_fd=dirfd)
            except OSError:
                pass


def write_via_dirfd(dirfd, basename, data, expect_dev, expect_ino):
    st = os.fstat(dirfd)
    if int(st.st_dev) != int(expect_dev) or int(st.st_ino) != int(expect_ino):
        raise PinError(f'打开的目录身份不符：{st.st_dev}:{st.st_ino} ≠ {expect_dev}:{expect_ino}')
    write_into(dirfd, basename, data)


def write_pinned(directory, basename, data, race_swap_to=None):
    """打开 directory 为不跟随的目录 fd 后，只通过该 fd 创建并替换文件。

    race_swap_to 仅供自测：在钉住 fd 之后把路径改成指向该目录的符号链接。
    写入仍必须落在原 inode，不得覆盖 race_swap_to 里的同名文件。
    """
    try:
        dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as e:
        raise PinError(f'无法以不跟随符号链接的方式打开批次目录 {directory}：{e}') from e
    try:
        if race_swap_to:
            moved = directory + '-moved'
            os.rename(directory, moved)
            os.symlink(race_swap_to, directory)
        write_into(dirfd, basename, data)
    finally:
        os.close(dirfd)


def self_test():
    root = tempfile.mkdtemp(prefix='m5-pin-')
    real = os.path.join(root, 'real')
    ext = os.path.join(root, 'ext')
    os.mkdir(real)
    os.mkdir(ext)
    sentinel = os.path.join(ext, 'batch.json')
    with open(sentinel, 'w', encoding='utf-8') as fh:
        fh.write('SENTINEL\n')
    write_pinned(real, 'batch.json', b'PINNED\n', race_swap_to=ext)
    with open(sentinel, encoding='utf-8') as fh:
        got = fh.read()
    if got != 'SENTINEL\n':
        raise PinError(f'钉住后换路仍写穿外部哨兵：{got!r}')
    moved = os.path.join(root, 'real-moved', 'batch.json')
    with open(moved, encoding='utf-8') as fh:
        pinned = fh.read()
    if pinned != 'PINNED\n':
        raise PinError('钉住目录内没有写入内容')
    link = os.path.join(root, 'link')
    os.symlink(ext, link)
    try:
        write_pinned(link, 'batch.json', b'NO\n')
    except PinError:
        pass
    else:
        raise PinError('符号链接目录必须失败')
    with open(sentinel, encoding='utf-8') as fh:
        if fh.read() != 'SENTINEL\n':
            raise PinError('符号链接目录写入改写了哨兵')
    print('ok')


def main():
    try:
        if len(sys.argv) == 2 and sys.argv[1] == '--self-test':
            self_test()
            return
        if len(sys.argv) == 6 and sys.argv[1] == '--dirfd':
            write_via_dirfd(int(sys.argv[2]), sys.argv[3], sys.stdin.buffer.read(), sys.argv[4], sys.argv[5])
            return
        if len(sys.argv) != 3:
            raise PinError('用法: ai-task-pinned-write.py --dirfd <fd> <basename> <dev> <ino> | --self-test')
        write_pinned(sys.argv[1], sys.argv[2], sys.stdin.buffer.read())
    except PinError as e:
        print(str(e), file=sys.stderr)
        sys.exit(e.code)


if __name__ == '__main__':
    main()

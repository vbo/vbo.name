title: "Handmade.app Chapter 0: Getting Started"
date: 2015-02-23 12:36:00
tags:
permalink: handmade-osx-getting-started
---

C/C++ on OS X
-------------
On OS X we have access to some great (and free) developer tools provided by Apple itself so let's use them. The main tool is called Xcode and this is a sort of IDE looking similar to Microsoft Visual Studio which Casey uses on Windows. You can download Xcode using App Store. This should install Xcode IDE, LLVM compiler and debugger and some other stuff we don't need to much.

You can open Xcode from the command line as follows:
```
$ open -a xcode
```

While you can absolutely use Xcode as an IDE it would be nice to use it only as a debugger (like Casey does with Visual Studio on the stream). For this purpose we need to access LLVM compiler from command line somehow. Recommended way to do this is to install a "Command Line Tools" package from inside of Xcode (Preferences -> Downloads -> Command Line Tools).

After this is done we should be able to use `clang` command from console to run the LLVM compiler. Let's test it:
```
$ cat > test.cpp
#include <stdio.h>

int main() {
  printf("Handmade Hero!\n");
}
$ clang test.cpp -g -o test
$ ./test
Handmade Hero!
```

Configuring Xcode
-----------------
To be able to debug our code we need to create Xcode project for our executable. Let's create an empty project with File -> New -> Project, choose Other -> Empty as a project type. After that use Product -> Scheme -> Create Scheme to configure project targets. We don't need to build anything with Xcode but we want to run our executable and debug it. So edit Run configuration of the scheme to use our executable: go to Run -> Info and put executable path to Executable dropdown.

Now you should be able to press Play button on the top left to launch the executable. It's not very convenient way to launch programs but it has a nice property of stopping execution of the process if error occures. For example if you try to dereference a NULL pointer your program should normally crash but when launched the debugger it would just stop and Xcode will show you what happend, visualize a call stack and allow you to check all variable values.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifdef __APPLE__
#define RENAME_EXCL 0x00000004
extern int renamex_np(const char *, const char *, unsigned int);
#endif

typedef struct { uint32_t h[8]; uint64_t bits; unsigned char block[64]; size_t used; } sha256_ctx;
static const uint32_t sha_k[64] = { 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 };
static uint32_t rr(uint32_t v,unsigned n){return(v>>n)|(v<<(32-n));}
static void sha_block(sha256_ctx*c,const unsigned char*p){uint32_t w[64],a,b,d,e,f,g,h,i,t1,t2,cc;for(i=0;i<16;i++)w[i]=((uint32_t)p[i*4]<<24)|((uint32_t)p[i*4+1]<<16)|((uint32_t)p[i*4+2]<<8)|p[i*4+3];for(i=16;i<64;i++){uint32_t x=w[i-15],y=w[i-2];w[i]=(rr(y,17)^rr(y,19)^(y>>10))+w[i-7]+(rr(x,7)^rr(x,18)^(x>>3))+w[i-16];}a=c->h[0];b=c->h[1];cc=c->h[2];d=c->h[3];e=c->h[4];f=c->h[5];g=c->h[6];h=c->h[7];for(i=0;i<64;i++){t1=h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^((~e)&g))+sha_k[i]+w[i];t2=(rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&cc)^(b&cc));h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;}c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;}
static void sha_init(sha256_ctx*c){static const uint32_t v[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};memcpy(c->h,v,sizeof(v));c->bits=0;c->used=0;}
static void sha_update(sha256_ctx*c,const unsigned char*p,size_t n){c->bits+=(uint64_t)n*8;while(n){size_t take=64-c->used;if(take>n)take=n;memcpy(c->block+c->used,p,take);c->used+=take;p+=take;n-=take;if(c->used==64){sha_block(c,c->block);c->used=0;}}}
static void sha_final(sha256_ctx*c,char out[65]){size_t i;c->block[c->used++]=0x80;if(c->used>56){while(c->used<64)c->block[c->used++]=0;sha_block(c,c->block);c->used=0;}while(c->used<56)c->block[c->used++]=0;for(i=0;i<8;i++)c->block[63-i]=(unsigned char)(c->bits>>(i*8));sha_block(c,c->block);for(i=0;i<8;i++)sprintf(out+i*8,"%08x",c->h[i]);out[64]=0;}

static void json(int ok,const char*code,const char*message,const char*extra){printf("{\"success\":%s,\"code\":\"%s\",\"error\":\"%s\"%s}\n",ok?"true":"false",code?code:"",message?message:"",extra?extra:"");}
static const char*map_code(int e){if(e==EEXIST||e==ENOTEMPTY)return"EEXIST";if(e==EXDEV)return"EXDEV";if(e==ENOENT)return"ENOENT";if(e==ENAMETOOLONG)return"ENAMETOOLONG";if(e==EACCES||e==EPERM)return"EACCES";return"FILE_PUBLICATION_FAILED";}
static const char*arg(int argc,char**argv,const char*name){int i;for(i=2;i+1<argc;i+=2)if(!strcmp(argv[i],name))return argv[i+1];return NULL;}
static int valid(const char*p){return p&&p[0]=='/';}
static int move_excl(const char*s,const char*t){
#ifdef __APPLE__
return renamex_np(s,t,RENAME_EXCL);
#else
return syscall(SYS_renameat2,AT_FDCWD,s,AT_FDCWD,t,1);
#endif
}
static void identity(const struct stat*s,char out[96]){snprintf(out,96,"%llu:%llu",(unsigned long long)s->st_dev,(unsigned long long)s->st_ino);}
static int verify_identity(int fd,const char*expected){struct stat s;char actual[96];if(fstat(fd,&s))return-1;identity(&s,actual);return strcmp(actual,expected)?1:0;}
static int verify_file(int fd,const char*hash,long long size){struct stat s;unsigned char buf[1024*1024];ssize_t n;sha256_ctx c;char actual[65];if(fstat(fd,&s))return-1;if(!S_ISREG(s.st_mode)||s.st_size!=size)return 1;if(lseek(fd,0,SEEK_SET)<0)return-1;sha_init(&c);while((n=read(fd,buf,sizeof(buf)))>0)sha_update(&c,buf,(size_t)n);if(n<0)return-1;sha_final(&c,actual);return strcasecmp(actual,hash)?1:0;}
static int same_path(int fd,const char*p){struct stat a,b;if(fstat(fd,&a)||lstat(p,&b))return-1;return(a.st_dev==b.st_dev&&a.st_ino==b.st_ino)?0:1;}
#ifdef PHOTOFLOW_TEST_FAULTS
static void test_replace_after_verify(const char*p){const char*watched=getenv("PHOTOFLOW_TEST_REPLACE_AFTER_VERIFY");const char*replacement=getenv("PHOTOFLOW_TEST_REPLACEMENT_PATH");const char*retained=getenv("PHOTOFLOW_TEST_RETAINED_PATH");if(watched&&replacement&&retained&&!strcmp(watched,p)){if(rename(p,retained)||rename(replacement,p)){fprintf(stderr,"test replacement injection failed: %s\n",strerror(errno));exit(90);}}}
static void test_batch_occupy_original(const char*p){const char*watched=getenv("PHOTOFLOW_TEST_BATCH_DELETE_OCCUPY_ORIGINAL");if(watched&&!strcmp(watched,p)){int fd=open(p,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);if(fd<0){fprintf(stderr,"test batch occupation injection failed: %s\n",strerror(errno));exit(91);}close(fd);}}
static void test_single_occupy_original(const char*p){const char*watched=getenv("PHOTOFLOW_TEST_SINGLE_DELETE_OCCUPY_ORIGINAL");if(watched&&!strcmp(watched,p)){int fd=open(p,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);if(fd<0){fprintf(stderr,"test single occupation injection failed: %s\n",strerror(errno));exit(92);}close(fd);}}
static int test_single_fail_unlink(const char*p){const char*watched=getenv("PHOTOFLOW_TEST_SINGLE_DELETE_FAIL_UNLINK");if(watched&&!strcmp(watched,p)){errno=EACCES;return 1;}return 0;}
static int test_batch_fail_unlink(const char*p){const char*watched=getenv("PHOTOFLOW_TEST_BATCH_DELETE_FAIL_UNLINK");if(watched&&!strcmp(watched,p)){errno=EACCES;return 1;}return 0;}
#else
static void test_replace_after_verify(const char*p){(void)p;}
static void test_batch_occupy_original(const char*p){(void)p;}
static void test_single_occupy_original(const char*p){(void)p;}
static int test_single_fail_unlink(const char*p){(void)p;return 0;}
static int test_batch_fail_unlink(const char*p){(void)p;return 0;}
#endif
static char*last_recovery=NULL;
static int restore_or_record(const char*q,const char*p,int saved){if(access(p,F_OK)!=0&&!move_excl(q,p)){errno=saved;return 0;}free(last_recovery);last_recovery=strdup(q);errno=saved;return-1;}
static int quarantine_delete(int fd,const char*p){static unsigned counter=0;size_t n=strlen(p)+96;char*q=(char*)malloc(n);int i,r,saved;if(!q){errno=ENOMEM;return-1;}for(i=0;i<32;i++){snprintf(q,n,"%s.photoflow-recovery-%ld-%u",p,(long)getpid(),++counter);if(!move_excl(p,q))break;if(errno!=EEXIST){free(q);return-1;}}if(i==32){free(q);errno=EEXIST;return-1;}test_single_occupy_original(p);r=same_path(fd,q);if(r){saved=ESTALE;restore_or_record(q,p,saved);free(q);return r>0?1:-1;}if(test_single_fail_unlink(p)||unlink(q)){saved=errno;restore_or_record(q,p,saved);free(q);return-1;}free(q);return 0;}
static int b64v(int c){if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;if(c>='0'&&c<='9')return c-'0'+52;if(c=='+')return 62;if(c=='/')return 63;return-1;}
static char*b64decode(const char*text){size_t n=strlen(text),i,o=0;char*out;if(!n||n%4)return NULL;out=(char*)malloc(n/4*3+1);if(!out)return NULL;for(i=0;i<n;i+=4){int a=b64v(text[i]),b=b64v(text[i+1]),c=text[i+2]=='='?-2:b64v(text[i+2]),d=text[i+3]=='='?-2:b64v(text[i+3]);if(a<0||b<0||c==-1||d==-1||(c==-2&&d!=-2)){free(out);return NULL;}out[o++]=(char)((a<<2)|(b>>4));if(c>=0){out[o++]=(char)((b<<4)|(c>>2));if(d>=0)out[o++]=(char)((c<<6)|d);}if((c==-2||d==-2)&&i+4!=n){free(out);return NULL;}}out[o]=0;if(strlen(out)!=o){free(out);return NULL;}return out;}
static char*b64encode(const unsigned char*data,size_t n){static const char t[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";size_t i,o=0;char*out=(char*)malloc(((n+2)/3)*4+1);if(!out)return NULL;for(i=0;i<n;i+=3){unsigned v=(unsigned)data[i]<<16;if(i+1<n)v|=(unsigned)data[i+1]<<8;if(i+2<n)v|=data[i+2];out[o++]=t[(v>>18)&63];out[o++]=t[(v>>12)&63];out[o++]=i+1<n?t[(v>>6)&63]:'=';out[o++]=i+2<n?t[v&63]:'=';}out[o]=0;return out;}
static int recovery_error(int e,const char*code,const char*message){if(last_recovery){char*encoded=b64encode((const unsigned char*)last_recovery,strlen(last_recovery));if(encoded){size_t n=strlen(encoded)+40;char*x=(char*)malloc(n);if(x){snprintf(x,n,",\"recoveryPathBase64\":\"%s\"",encoded);json(0,code,message,x);free(x);free(encoded);return 1;}free(encoded);}}json(0,code,message,NULL);return 1;}
static int fail_errno(void){int e=errno;return recovery_error(e,map_code(e),strerror(e));}
static int conflict(const char*m){return recovery_error(ESTALE,"PUBLISH_OWNERSHIP_CONFLICT",m);}
static int split_fields(char*line,char**fields,int count){int i;size_t n=strlen(line);while(n&&(line[n-1]=='\n'||line[n-1]=='\r'))line[--n]=0;fields[0]=line;for(i=1;i<count;i++){fields[i]=strchr(fields[i-1],'\t');if(!fields[i])return-1;*fields[i]++=0;}return strchr(fields[count-1],'\t')?-1:0;}
static int batch_inspect(const char*manifest){FILE*f;char*line=NULL;size_t cap=0;ssize_t len;int expected=0,first=1;if(!valid(manifest)){json(0,"EINVAL","absolute manifest required",NULL);return 1;}f=fopen(manifest,"r");if(!f)return fail_errno();printf("{\"success\":true,\"results\":[");while((len=getline(&line,&cap,f))>=0){char*parts[2],*p;long index;struct stat st;char id[96];if(split_fields(line,parts,2)){free(line);fclose(f);json(0,"EINVAL","invalid inspection manifest",NULL);return 1;}index=strtol(parts[0],NULL,10);p=b64decode(parts[1]);if(index!=expected++||!p||!valid(p)){free(p);free(line);fclose(f);json(0,"EINVAL","invalid inspection item",NULL);return 1;}if(!first)printf(",");first=0;if(lstat(p,&st))printf("{\"index\":%ld,\"success\":false,\"code\":\"%s\",\"error\":\"path unavailable\"}",index,map_code(errno));else{identity(&st,id);printf("{\"index\":%ld,\"success\":true,\"identity\":\"%s\",\"directory\":%s}",index,id,S_ISDIR(st.st_mode)?"true":"false");}free(p);if(expected>4096){free(line);fclose(f);json(0,"EINVAL","inspection batch too large",NULL);return 1;}}free(line);fclose(f);printf("]}\n");return 0;}
static int batch_move(const char*manifest){FILE*f;char*line=NULL;size_t cap=0;ssize_t len;int expected=0,first=1,stop=0;if(!valid(manifest)){json(0,"EINVAL","absolute manifest required",NULL);return 1;}f=fopen(manifest,"r");if(!f)return fail_errno();printf("{\"success\":true,\"results\":[");while(!stop&&(len=getline(&line,&cap,f))>=0){char*parts[4],*s,*t,*wanted;long index;int fd,r;struct stat st;char id[96];if(split_fields(line,parts,4)){free(line);fclose(f);json(0,"EINVAL","invalid publication manifest",NULL);return 1;}index=strtol(parts[0],NULL,10);s=b64decode(parts[1]);t=b64decode(parts[2]);wanted=b64decode(parts[3]);if(index!=expected++||!s||!t||!wanted||!valid(s)||!valid(t)||!strcmp(s,t)){free(s);free(t);free(wanted);free(line);fclose(f);json(0,"EINVAL","invalid publication item",NULL);return 1;}if(!first)printf(",");first=0;fd=open(s,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0){printf("{\"index\":%ld,\"success\":false,\"code\":\"%s\",\"error\":\"source unavailable\"}",index,map_code(errno));stop=1;}else if((r=verify_identity(fd,wanted))!=0){printf("{\"index\":%ld,\"success\":false,\"code\":\"PUBLISH_OWNERSHIP_CONFLICT\",\"error\":\"source identity changed\"}",index);stop=1;close(fd);}else if(move_excl(s,t)){printf("{\"index\":%ld,\"success\":false,\"code\":\"%s\",\"error\":\"publication failed\"}",index,map_code(errno));stop=1;close(fd);}else if(same_path(fd,t)){printf("{\"index\":%ld,\"success\":false,\"code\":\"PUBLISH_OWNERSHIP_CONFLICT\",\"error\":\"published target identity changed\"}",index);stop=1;close(fd);}else{fstat(fd,&st);identity(&st,id);close(fd);printf("{\"index\":%ld,\"success\":true,\"strategy\":\"posix-batch-rename-no-replace\",\"identity\":\"%s\"}",index,id);}free(s);free(t);free(wanted);if(expected>2048){free(line);fclose(f);json(0,"EINVAL","publication batch too large",NULL);return 1;}}free(line);fclose(f);printf("]}\n");return 0;}
static int batch_delete(const char*manifest){
 FILE*f;char*line=NULL;size_t cap=0;ssize_t len;int expected=0,first=1;
 if(!valid(manifest)){json(0,"EINVAL","absolute manifest required",NULL);return 1;}
 f=fopen(manifest,"r");if(!f)return fail_errno();printf("{\"success\":true,\"results\":[");
 while((len=getline(&line,&cap,f))>=0){
  char*parts[3],*p,*wanted,*q,*encoded=NULL;long index;int fd,r,owned=0,restored=0;
  if(split_fields(line,parts,3)){free(line);fclose(f);json(0,"EINVAL","invalid cleanup manifest",NULL);return 1;}
  index=strtol(parts[0],NULL,10);p=b64decode(parts[1]);wanted=b64decode(parts[2]);
  if(index!=expected++||!p||!wanted||!valid(p)){free(p);free(wanted);free(line);fclose(f);json(0,"EINVAL","invalid cleanup item",NULL);return 1;}
  q=(char*)malloc(strlen(p)+80);if(!q){free(p);free(wanted);free(line);fclose(f);json(0,"FILE_PUBLICATION_FAILED","out of memory",NULL);return 1;}
  snprintf(q,strlen(p)+80,"%s.photoflow-quarantine-%ld-%ld",p,(long)getpid(),index);
  if(!first)printf(",");first=0;
  if(move_excl(p,q))printf("{\"index\":%ld,\"success\":false,\"code\":\"%s\",\"error\":\"cleanup quarantine failed\"}",index,map_code(errno));
  else{
   test_batch_occupy_original(p);
   fd=open(q,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd>=0){r=verify_identity(fd,wanted);if(!r)r=same_path(fd,q);if(!r)owned=1;close(fd);}
   if(!owned){
    if(access(p,F_OK)!=0&&move_excl(q,p)==0)restored=1;
    if(!restored)encoded=b64encode((const unsigned char*)q,strlen(q));
    printf("{\"index\":%ld,\"success\":false,\"code\":\"PUBLISH_OWNERSHIP_CONFLICT\",\"error\":\"cleanup identity changed\"%s%s%s}",index,encoded?",\"recoveryPathBase64\":\"":"",encoded?encoded:"",encoded?"\"":"");
   }else if(test_batch_fail_unlink(p)||unlink(q)){
    encoded=b64encode((const unsigned char*)q,strlen(q));
    printf("{\"index\":%ld,\"success\":false,\"code\":\"%s\",\"error\":\"quarantine cleanup failed\",\"recoveryPathBase64\":\"%s\"}",index,map_code(errno),encoded?encoded:"");
   }else printf("{\"index\":%ld,\"success\":true,\"deleted\":true}",index);
  }
  free(encoded);free(q);free(p);free(wanted);if(expected>2048){free(line);fclose(f);json(0,"EINVAL","cleanup batch too large",NULL);return 1;}
 }
 free(line);fclose(f);printf("]}\n");return 0;
}

int main(int argc,char**argv){
 if(argc<2){json(0,"EINVAL","missing operation",NULL);return 1;}const char*op=argv[1];
 if(!strcmp(op,"move-no-replace-batch")){const char*m=arg(argc,argv,"--manifest");return batch_move(m);}
 if(!strcmp(op,"inspect-path-batch")){const char*m=arg(argc,argv,"--manifest");return batch_inspect(m);}
 if(!strcmp(op,"delete-paths-batch")){const char*m=arg(argc,argv,"--manifest");return batch_delete(m);}
 if(!strcmp(op,"move-no-replace")){const char*s=arg(argc,argv,"--source"),*t=arg(argc,argv,"--target");struct stat st;char id[96],extra[180];int fd;if(!valid(s)||!valid(t)){json(0,"EINVAL","absolute paths required",NULL);return 1;}fd=open(s,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return fail_errno();if(fstat(fd,&st)){close(fd);return fail_errno();}identity(&st,id);if(move_excl(s,t)){close(fd);return fail_errno();}close(fd);snprintf(extra,sizeof(extra),",\"strategy\":\"posix-rename-no-replace\",\"identity\":\"%s\"",id);json(1,"","",extra);return 0;}
 if(!strcmp(op,"inspect-path")){const char*p=arg(argc,argv,"--path");struct stat s;char id[96],extra[180];if(!valid(p)){json(0,"EINVAL","absolute path required",NULL);return 1;}if(lstat(p,&s))return fail_errno();identity(&s,id);snprintf(extra,sizeof(extra),",\"identity\":\"%s\",\"directory\":%s",id,S_ISDIR(s.st_mode)?"true":"false");json(1,"","",extra);return 0;}
 if(!strcmp(op,"compare-delete-file")){const char*p=arg(argc,argv,"--target"),*h=arg(argc,argv,"--sha256"),*id=arg(argc,argv,"--identity"),*z=arg(argc,argv,"--size");int fd,r;if(!valid(p)||!h||!id||!z){json(0,"EINVAL","invalid arguments",NULL);return 1;}fd=open(p,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return fail_errno();r=verify_identity(fd,id);if(!r)r=verify_file(fd,h,atoll(z));if(!r)test_replace_after_verify(p);if(!r)r=quarantine_delete(fd,p);if(r){close(fd);return r>0?conflict("compensation target identity or digest changed"):fail_errno();}close(fd);json(1,"","",",\"deleted\":true");return 0;}
 if(!strcmp(op,"commit-cross-volume-file")){const char*s=arg(argc,argv,"--source"),*st=arg(argc,argv,"--staged"),*t=arg(argc,argv,"--target"),*h=arg(argc,argv,"--sha256"),*id=arg(argc,argv,"--source-identity"),*z=arg(argc,argv,"--size");int sf,tf,r;if(!valid(s)||!valid(st)||!valid(t)||!h||!id||!z){json(0,"EINVAL","invalid arguments",NULL);return 1;}sf=open(s,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(sf<0)return fail_errno();r=verify_identity(sf,id);if(r){close(sf);return r>0?conflict("source identity changed before publish"):fail_errno();}tf=open(st,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(tf<0){close(sf);return fail_errno();}r=verify_file(tf,h,atoll(z));if(r){close(sf);close(tf);return r>0?conflict("staged digest changed before publish"):fail_errno();}if(move_excl(st,t)){close(sf);close(tf);return fail_errno();}r=same_path(tf,t);if(!r)r=verify_file(tf,h,atoll(z));if(r){close(sf);close(tf);return r>0?conflict("published target identity or digest changed"):fail_errno();}r=verify_file(sf,h,atoll(z));if(!r)test_replace_after_verify(s);if(!r)r=quarantine_delete(sf,s);if(r){close(sf);close(tf);return r>0?conflict("source identity or digest changed"):fail_errno();}close(sf);close(tf);json(1,"","",",\"strategy\":\"posix-cross-volume-identity-commit\"");return 0;}
 json(0,"EINVAL","unsupported operation",NULL);return 1;
}

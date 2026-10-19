import {test,expect} from '@playwright/test';
test('recorded evidence and synchronized interaction',async({page})=>{
 const errors=[];page.on('pageerror',e=>(errors.push(e.message),console.log(e.message)));
 await page.goto('http://127.0.0.1:5173');
 await expect(page.getByRole('heading',{name:'Compare scaling policies.'})).toBeVisible();
 await expect(page.locator('.charts svg')).toHaveCount(4);
 await expect(page.locator('tr.selected')).toHaveCount(2);
 await page.getByRole('button',{name:'Trial 2',exact:true}).click();
 await expect(page.locator('tr.selected').first()).toContainText('897');
 await page.locator('#sample').fill('30');
 await expect(page.locator('output')).toHaveText('2:30');
 await expect(page.locator('.timestamps')).toContainText('11:33:57 UTC');
 await expect(page.locator('.chart').last().locator('.readout')).toContainText('CPU HPA: 2 targets');
 await page.getByRole('button',{name:'Trial 1',exact:true}).click();
 await expect(page.locator('output')).toHaveText('0:00');
 for(const a of await page.locator('a[href^="/evidence/"]').all()){const res=await page.request.get(await a.getAttribute('href'));expect(res.ok()).toBeTruthy();}
 await page.screenshot({path:'desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await expect(page.getByRole('button',{name:'Trial 2',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 for(const b of await page.locator('button').all()){const box=await b.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);}
 await page.screenshot({path:'mobile.png',fullPage:true});
 expect(errors).toEqual([]);
});

